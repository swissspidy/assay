import type { BrowserContext, Frame, Page, Request } from '@playwright/test';
import {
  SNAPSHOT_SCHEMA,
  type Baseline,
  type CookieRecord,
  type EvidenceSnapshot,
  type Json,
  type NetworkEntry,
  type PageView,
  type ProbeResult,
  type StorageRecord,
  type Redacted,
  type TrajectoryEvent,
} from '../types.ts';
import { parseAriaSnapshot } from './aria.ts';
import { formObject, multipartBoundary, parseMultipart, type FormValue } from './body.ts';
import { attachFrames, FRAME_LIMITS } from './frames.ts';
import { randomUUID } from 'node:crypto';
import { ASSAY_VERSION } from '../version.ts';
import { sealDigest } from './digest.ts';

/** Names the capturing package and its version. */
export const CAPTURER = ASSAY_VERSION;

const KEEP_REQUEST_HEADERS = ['content-type', 'accept'];
const KEEP_RESPONSE_HEADERS = ['content-type', 'location'];
/** Response bodies are kept for API calls only; document HTML is noise for checks. */
const BODY_RESOURCE_TYPES = new Set(['fetch', 'xhr']);

export interface RecorderOptions {
  /** Max bytes of a request/response body kept in the log (default 1 MiB). */
  maxBodyBytes?: number;
  /**
   * Max ms to wait for one response body (default 3000). Chromium can leave a
   * body read pending forever once the page has navigated away; such a body is
   * then filled from the page tap or marked unavailable.
   */
  bodyTimeoutMs?: number;
  /**
   * Also record the run's trajectory (ADR 0024): every request and every main-frame
   * navigation, in order, with the time since the recorder was attached. Snapshots then carry
   * it as `trajectory`, which `sequence` checks read. Default false: snapshots are unchanged.
   */
  trajectory?: boolean;
}

const TIMED_OUT = Symbol('timeout');

/** Resolve with the promise's value, or TIMED_OUT after `ms`; never leaves a timer running. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pick(headers: Record<string, string>, keep: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keep) if (headers[k] !== undefined) out[k] = headers[k];
  return out;
}

/**
 * The first `max` UTF-8 bytes of `text`, cut at a character boundary, or undefined
 * when it fits. (A streaming decode drops an incomplete trailing character.)
 */
export function cutUtf8(text: string, max: number): string | undefined {
  const bytes = Buffer.from(text, 'utf8');
  const limit = Math.max(0, max);
  return bytes.length > limit ? new TextDecoder().decode(bytes.subarray(0, limit), { stream: true }) : undefined;
}

/** @internal Exported for tests. */
export function decodeBody(
  text: string,
  contentType: string | undefined,
  max: number,
): { body: Json; truncated: boolean } {
  const cut = cutUtf8(text, max);
  if (cut !== undefined) return { body: cut, truncated: true };
  if (contentType && /\bjson\b/i.test(contentType)) {
    try {
      return { body: JSON.parse(text) as Json, truncated: false };
    } catch {
      /* fall through to text */
    }
  }
  if (contentType && /application\/x-www-form-urlencoded/i.test(contentType)) {
    // HTML form posts become objects (repeated fields become arrays), so checks can
    // match them with JSON Schema like JSON bodies.
    return { body: formObject(new URLSearchParams(text)), truncated: false };
  }
  return { body: text, truncated: false };
}

/**
 * A request body as recorded: JSON parsed, form bodies (URL-encoded and multipart) parsed
 * into their fields with their text kept as `raw`, anything else as text. In a multipart
 * body, files are recorded by filename, type and size; their content is never kept, and
 * does not count towards `max`. A body over `max` bytes is kept as cut text. A multipart body
 * that does not parse gives undefined: kept as text it could hold a file's bytes.
 * @internal Exported for tests.
 */
export function decodeRequestBody(
  buf: Buffer,
  contentType: string | undefined,
  max: number,
): { body: Json; raw?: string; truncated: boolean } | undefined {
  if (isMultipart(contentType)) {
    const boundary = multipartBoundary(contentType);
    const multipart = boundary !== undefined ? parseMultipart(buf, boundary) : undefined;
    if (!multipart) return undefined;
    const cut = cutUtf8(multipart.raw, max);
    if (cut !== undefined) return { body: cut, truncated: true };
    return { body: formObject(multipart.fields), raw: multipart.raw, truncated: false };
  }
  const text = buf.toString('utf8');
  const decoded = decodeBody(text, contentType, max);
  const form = !decoded.truncated && contentType && /application\/x-www-form-urlencoded/i.test(contentType);
  return form ? { ...decoded, raw: text } : decoded;
}

const isMultipart = (contentType: string | undefined) => !!contentType && /^\s*multipart\//i.test(contentType);

function isTextual(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /json|text\/|xml|javascript|x-www-form-urlencoded/i.test(contentType);
}

/** Marks a cut body: bodyTruncated for older readers, and which body it was (ADR 0012). */
function markTruncated(e: NetworkEntry, which: 'request' | 'response'): void {
  e.bodyTruncated = true;
  if (which === 'request') e.requestBodyTruncated = true;
  else e.responseBodyTruncated = true;
}

/** Response body observed inside the page by the init-script tap (see pageTap). */
interface TappedBody {
  method: string;
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

/**
 * Multipart form fields the tap saw the page send (a form submission, or FormData given
 * to fetch or XHR). Browsers leave file uploads out of the request's post data, so this is
 * the only place their names, types and sizes can be read. `id` numbers a form's report;
 * `supersedes` names an earlier report of the same FormData that a fetch or XHR sent. Ids are
 * unique per document (a random prefix), so frames and navigations cannot collide.
 */
interface TappedForm {
  method: string;
  url: string;
  fields: [string, FormValue][];
  id?: string;
  supersedes?: string;
}

type TapMessage = ({ kind?: undefined } & TappedBody) | ({ kind: 'form' } & TappedForm);

/** A reported form field has the shape the tap sends: a name and text, or a file's metadata. */
function isFormField(x: unknown): x is [string, FormValue] {
  if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string') return false;
  const v: unknown = x[1];
  if (typeof v === 'string') return true;
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    Object.keys(f).length === 3 &&
    typeof f.filename === 'string' &&
    typeof f.type === 'string' &&
    typeof f.size === 'number' &&
    Number.isFinite(f.size)
  );
}

/**
 * Init script that tees fetch/XHR response bodies to the recorder. Chromium drops
 * bodies as soon as the page navigates (e.g. POST then redirect to a confirmation
 * page), so reading them later via the protocol is unreliable. Every call carries
 * a random token held only in this script's closure, so page scripts that find
 * the binding cannot forge network evidence. The tap only fills in bodies of
 * requests the browser itself reported; it never adds entries. It must never
 * throw into page code.
 */
function pageTap(bindingName: string, token: string, max: number): string {
  return `(() => {
  const send = window[${JSON.stringify(bindingName)}];
  if (typeof send !== 'function') return;
  const T = ${JSON.stringify(token)}, MAX = ${max};
  const textual = (ct) => /json|text[/]|xml|javascript|x-www-form-urlencoded/i.test(ct || '') && !/event-stream/i.test(ct || '');
  // MAX counts UTF-8 bytes; cuts fall on character boundaries (a streaming decode
  // drops an incomplete trailing character).
  const enc = new TextEncoder();
  const capBytes = (text) => {
    const bytes = enc.encode(text);
    return bytes.length > MAX ? { text: new TextDecoder().decode(bytes.subarray(0, MAX), { stream: true }), cut: true } : { text, cut: false };
  };
  const post = (method, url, status, ct, raw, wasCut) => {
    try {
      const { text, cut } = capBytes(raw);
      send({ token: T, method: String(method).toUpperCase(), url: String(url), status, contentType: ct || '', body: text, truncated: !!wasCut || cut });
    } catch {}
  };
  // Multipart form fields as sent; files by name, type and size only, never content.
  const FD = window.FormData;
  const fields = (fd) => {
    const out = [];
    for (const [k, v] of fd) out.push([String(k), typeof v === 'string' ? v : { filename: String(v.name || ''), type: String(v.type || 'application/octet-stream'), size: Number(v.size) || 0 }]);
    return out;
  };
  // FormData objects a form built (formdata event) -> the id of their report.
  const formIds = new WeakMap();
  // Ids of form reports: unique per document, so one frame's cannot name another's.
  const DOC = Math.random().toString(36).slice(2);
  let lastId = 0;
  const postForm = (method, url, fd, extra) => {
    try {
      const u = new URL(String(url), location.href);
      u.hash = ''; // requests never carry the fragment
      send({ token: T, kind: 'form', method: String(method || 'GET').toUpperCase(), url: u.href, fields: fields(fd), ...extra });
    } catch {}
  };
  const sentForm = (method, url, body) => {
    try {
      if (!FD || !(body instanceof FD)) return;
      const id = formIds.get(body);
      postForm(method, url, body, id ? { supersedes: id } : {});
    } catch {}
  };
  // Captured now, so page scripts that replace timers cannot stall the tap.
  const later = window.setTimeout.bind(window);
  if (FD) {
    // The button that submitted each form, for its formaction/formmethod/formenctype.
    const submitters = new WeakMap();
    // The last report per form, for a moment: Chromium builds one submission's entry list
    // (and fires formdata) twice, a task apart, which must not count as two submissions.
    // A second identical submission within that moment is then reported once; the
    // recorder sees two requests for one report and leaves both bodies unavailable.
    const recent = new WeakMap();
    const DEDUPE_MS = 1000;
    window.addEventListener('submit', (e) => {
      try {
        const form = e.target;
        submitters.set(form, e.submitter || null);
        later(() => submitters.delete(form), 0);
      } catch {}
    }, true);
    // A multipart form submission (or new FormData(form)): read the entries at the form
    // itself, after the page's own formdata listeners there have added theirs.
    window.addEventListener('formdata', (e) => {
      try {
        const form = e.target, fd = e.formData;
        if (!form || form.tagName !== 'FORM' || !fd) return;
        const s = submitters.get(form);
        const pick = (attr, prop, own) => (s && s.hasAttribute && s.hasAttribute(attr) ? s[prop] : form[own]);
        const method = String(pick('formmethod', 'formMethod', 'method') || 'get').toLowerCase();
        const enc = String(pick('formenctype', 'formEnctype', 'enctype') || '').toLowerCase();
        if (method !== 'post' || enc !== 'multipart/form-data') return;
        const url = String(pick('formaction', 'formAction', 'action'));
        const atForm = (ev) => {
          if (ev.formData !== fd) return;
          form.removeEventListener('formdata', atForm);
          const key = url + '\\n' + JSON.stringify(fields(fd));
          const prev = recent.get(form);
          if (prev && prev.key === key) {
            formIds.set(fd, prev.id);
            return;
          }
          const id = DOC + ':' + ++lastId;
          formIds.set(fd, id);
          recent.set(form, { key, id });
          later(() => { if (recent.get(form)?.id === id) recent.delete(form); }, DEDUPE_MS);
          postForm('POST', url, fd, { id });
        };
        form.addEventListener('formdata', atForm);
      } catch {}
    }, true);
  }
  const WAIT = 500;
  // Reads at most MAX bytes of a body, then stops (streams may never end).
  // Reads at most MAX bytes of a body, then stops (streams may never end). A body
  // still open after DEADLINE ms is cut there, so stalled streams release the reader.
  const DEADLINE = 10000;
  const readCapped = async (body) => {
    const reader = body.getReader(), dec = new TextDecoder();
    let text = '', bytes = 0;
    const stop = new Promise((r) => later(() => r(null), DEADLINE));
    for (;;) {
      const next = await Promise.race([reader.read(), stop]);
      if (next === null) { reader.cancel().catch(() => {}); return { text, cut: true }; }
      const { done, value } = next;
      if (done) return { text: text + dec.decode(), cut: false };
      if (bytes + value.byteLength > MAX) {
        reader.cancel().catch(() => {});
        return { text: text + dec.decode(value.subarray(0, MAX - bytes), { stream: true }), cut: true };
      }
      bytes += value.byteLength;
      text += dec.decode(value, { stream: true });
    }
  };
  const origFetch = window.fetch;
  if (origFetch) {
    // The page receives the response once the tap has read (a clone of) its body and
    // reported it, or after WAIT ms, whichever comes first. Reading concurrently would
    // race the page: an app that navigates as soon as it has the data (POST, then
    // location.href = ...) can unload before a concurrent read finishes. The bound keeps
    // streaming responses from being held up; their read continues in the background.
    window.fetch = function (input, init) {
      let method = 'GET';
      try {
        method = (init && init.method) || (input && typeof input === 'object' && 'method' in input ? input.method : 'GET');
        if (init && init.body) sentForm(method, input && typeof input === 'object' && 'url' in input ? input.url : input, init.body);
        // A Request built with a FormData body: its body can only be read as a copy, which
        // must happen before fetch consumes it.
        else if (typeof Request === 'function' && input instanceof Request && input.body && !input.bodyUsed && /^ *multipart[/]/i.test(input.headers.get('content-type') || '')) {
          const copy = input.clone();
          copy.formData().then((fd) => postForm(input.method, input.url, fd, {}), () => {});
        }
      } catch {}
      const p = origFetch.apply(this, arguments);
      return p.then((res) => {
        try {
          const ct = res.headers.get('content-type');
          if (!textual(ct) || !res.body) return res;
          const reported = readCapped(res.clone().body).then(
            ({ text, cut }) => post(method, res.url, res.status, ct, text, cut),
            () => {},
          );
          return Promise.race([reported, new Promise((r) => later(r, WAIT))]).then(() => res, () => res);
        } catch {
          return res;
        }
      });
    };
  }
  const X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (X) {
    const open = X.open, sendX = X.send;
    X.open = function (method, url) { this.__assayMethod = method; this.__assayUrl = url; return open.apply(this, arguments); };
    X.send = function (body) {
      try {
        if (body) sentForm(this.__assayMethod, this.__assayUrl, body);
      } catch {}
      try {
        // Once per XHR object: a reused XHR must not report each response twice.
        if (!this.__assayTapped) {
          this.__assayTapped = true;
          this.addEventListener('load', () => {
          try {
            const ct = this.getResponseHeader('content-type');
            if (!textual(ct)) return;
            let t;
            if (this.responseType === '' || this.responseType === 'text') t = this.responseText;
            else if (this.responseType === 'json') t = JSON.stringify(this.response);
            else return;
            post(this.__assayMethod || 'GET', this.responseURL, this.status, ct, t);
          } catch {}
          });
        }
      } catch {}
      return sendX.apply(this, arguments);
    };
  }
})();`;
}

/**
 * Records the network log of a browser context. Attach it before the agent acts:
 * requests issued before attachment are not in the log.
 */
export class EvidenceRecorder {
  private static readonly byContext = new WeakMap<BrowserContext, Promise<EvidenceRecorder>>();
  private static readonly ready = new WeakMap<BrowserContext, EvidenceRecorder>();
  private readonly entries: NetworkEntry[] = [];
  private readonly byRequest = new Map<Request, NetworkEntry>();
  private readonly pending = new Set<Promise<void>>();
  private readonly tapped: (TappedBody & { frame: Frame | undefined })[] = [];
  private readonly tappedForms: (TappedForm & { frame: Frame | undefined })[] = [];
  /** The frame that issued each entry's request, to group it with bodies tapped in that frame. */
  private readonly frameOf = new WeakMap<NetworkEntry, Frame>();
  private readonly frameIds = new WeakMap<Frame, number>();
  private frameCount = 0;
  private seq = 0;
  private readonly maxBody: number;
  private readonly bodyTimeout: number;
  private readonly token = randomUUID();
  /** The trajectory so far; undefined when it is not recorded. */
  private readonly events: TrajectoryEvent[] | undefined;
  private readonly startedAt = performance.now();
  private readonly pageIds = new WeakMap<Page, number>();
  private pageCount = 0;

  readonly context: BrowserContext;

  private constructor(context: BrowserContext, opts: RecorderOptions) {
    this.context = context;
    this.maxBody = Math.max(0, opts.maxBodyBytes ?? 1024 * 1024);
    this.bodyTimeout = opts.bodyTimeoutMs ?? 3000;
    this.events = opts.trajectory ? [] : undefined;
    context.on('request', (req) => this.onRequest(req));
    context.on('response', (resp) => this.track(this.onResponse(resp.request())));
    context.on('requestfailed', (req) => this.onFailed(req));
    // Page activity: when each page last opened or navigated, to find the active one.
    const watch = (p: Page) => {
      this.touch(p);
      this.pageIds.set(p, this.pageCount++);
      p.on('framenavigated', (f) => {
        if (f !== p.mainFrame()) return;
        this.touch(p);
        this.events?.push({ type: 'navigation', url: f.url(), page: this.pageIds.get(p)!, t: this.now() });
      });
    };
    context.pages().forEach(watch);
    context.on('page', watch);
  }

  private readonly activity = new WeakMap<Page, number>();
  private ticks = 0;

  /** Whole milliseconds since the recorder was attached. */
  private now(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  private touch(p: Page): void {
    this.activity.set(p, ++this.ticks);
  }

  /** When `page` last opened or navigated, relative to the context's other pages (undefined: not seen). */
  lastActive(page: Page): number | undefined {
    return this.activity.get(page);
  }

  /** Attach a recorder to a context (idempotent). Pages opened afterwards get the body tap. */
  static attach(context: BrowserContext, opts: RecorderOptions = {}): Promise<EvidenceRecorder> {
    let p = EvidenceRecorder.byContext.get(context);
    if (!p) {
      const rec = new EvidenceRecorder(context, opts);
      p = rec.install().then(() => {
        EvidenceRecorder.ready.set(context, rec);
        return rec;
      });
      EvidenceRecorder.byContext.set(context, p);
    }
    return p;
  }

  static for(context: BrowserContext): EvidenceRecorder | undefined {
    return EvidenceRecorder.ready.get(context);
  }

  private async install(): Promise<void> {
    const name = `__assay_${this.token.replace(/-/g, '').slice(0, 12)}`;
    await this.context.exposeBinding(name, (source, payload: TapMessage & { token?: string }) => {
      if (!payload || payload.token !== this.token) return;
      if (payload.kind === 'form') {
        const { method, url, fields, id, supersedes } = payload;
        if (typeof method !== 'string' || typeof url !== 'string' || !Array.isArray(fields)) return;
        if (!fields.every(isFormField)) return;
        this.tappedForms.push({
          method,
          url,
          fields: fields.map(([k, v]) => [k, typeof v === 'string' ? v : { ...v }]),
          ...(typeof id === 'string' ? { id } : {}),
          ...(typeof supersedes === 'string' ? { supersedes } : {}),
          frame: source.frame,
        });
        return;
      }
      const { token: _t, kind: _k, ...body } = payload;
      this.tapped.push({ ...body, frame: source.frame });
    });
    await this.context.addInitScript({ content: pageTap(name, this.token, this.maxBody) });
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private onRequest(req: Request): void {
    const headers = req.headers();
    const entry: NetworkEntry = {
      seq: this.seq++,
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      status: null,
      requestHeaders: pick(headers, KEEP_REQUEST_HEADERS),
      responseHeaders: {},
    };
    const post = req.postDataBuffer();
    const decoded = post != null ? decodeRequestBody(post, headers['content-type'], this.maxBody) : undefined;
    if (decoded) {
      entry.requestBody = decoded.body;
      if (decoded.raw !== undefined) entry.requestBodyRaw = decoded.raw;
      if (decoded.truncated) markTruncated(entry, 'request');
    } else if (isMultipart(headers['content-type']) && !['GET', 'HEAD', 'OPTIONS'].includes(entry.method)) {
      // A multipart body was sent but not reported (Chromium leaves out bodies with files)
      // or did not parse; the page tap may fill it in at settle(). Other bodies the browser
      // does not report are left out as before: a POST may set a content type and send none.
      entry.requestBodyUnavailable = true;
    }
    this.entries.push(entry);
    this.events?.push({ type: 'request', seq: entry.seq, t: this.now() });
    this.byRequest.set(req, entry);
    try {
      this.frameOf.set(entry, req.frame());
    } catch {
      /* service worker requests have no frame */
    }
  }

  private async onResponse(req: Request): Promise<void> {
    const entry = this.byRequest.get(req);
    if (!entry) return;
    const resp = await within(
      req.response().catch(() => null),
      this.bodyTimeout,
    );
    if (!resp || resp === TIMED_OUT) return;
    entry.status = resp.status();
    const headers = resp.headers();
    entry.responseHeaders = pick(headers, KEEP_RESPONSE_HEADERS);
    const ct = headers['content-type'];
    if (!BODY_RESOURCE_TYPES.has(entry.resourceType) || !isTextual(ct)) return;
    if (entry.status >= 300 && entry.status < 400) return; // redirects have no body
    try {
      const buf = await within(resp.body(), this.bodyTimeout);
      if (buf === TIMED_OUT) return; // evicted; the page tap usually has it
      const text = buf.toString('utf8');
      const { body, truncated } = decodeBody(text, ct, this.maxBody);
      entry.responseBody = body;
      if (truncated) markTruncated(entry, 'response');
    } catch {
      /* evicted (e.g. the page navigated); the page tap usually has it */
    }
  }

  private onFailed(req: Request): void {
    const entry = this.byRequest.get(req);
    if (entry) entry.failure = req.failure()?.errorText ?? 'failed';
  }

  /** Wait until bodies of finished requests have been read, then fill gaps from the page tap. */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(this.pending);
    // Tapped bodies carry no request identity, only frame, method, URL and status.
    // A body fills a request only when no other assignment could differ: the requests
    // to that method and URL from that frame pair one to one with the tapped bodies
    // (equal counts), and those bodies are all identical. Anything ambiguous stays
    // unavailable, so checks on it abstain instead of reading another request's body.
    const groups = new Map<string, { entries: NetworkEntry[]; taps: TappedBody[] }>();
    const group = (frame: Frame | undefined, method: string, url: string) => {
      const key = `${frame ? this.frameId(frame) : '-'} ${method} ${url}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { entries: [], taps: [] }));
      return g;
    };
    for (const e of this.entries) {
      // A request that failed before a response has no tapped body to pair with.
      if (BODY_RESOURCE_TYPES.has(e.resourceType) && !(e.failure !== undefined && e.status === null))
        group(this.frameOf.get(e), e.method, e.url).entries.push(e);
    }
    for (const t of this.tapped) group(t.frame, t.method, t.url).taps.push(t);
    for (const { entries, taps } of groups.values()) {
      const [t, ...rest] = taps;
      if (!t || entries.length !== taps.length) continue;
      const same = (x: TappedBody) =>
        x.status === t.status && x.contentType === t.contentType && x.body === t.body && x.truncated === t.truncated;
      if (!rest.every(same)) continue;
      for (const e of entries) {
        // A failed request has no response, so it never gets a body.
        if (e.responseBody !== undefined || e.failure !== undefined || (e.status !== null && e.status !== t.status))
          continue;
        const { body, truncated } = decodeBody(t.body, t.contentType, this.maxBody);
        e.responseBody = body;
        if (truncated || t.truncated) markTruncated(e, 'response');
      }
    }
    this.fillForms();
    for (const e of this.entries) {
      const ct = e.responseHeaders['content-type'];
      const expected =
        BODY_RESOURCE_TYPES.has(e.resourceType) &&
        e.status !== null &&
        (e.status < 300 || e.status >= 400) &&
        isTextual(ct);
      if (expected && e.responseBody === undefined) e.bodyUnavailable = true;
      else delete e.bodyUnavailable;
    }
  }

  /**
   * Fill multipart request bodies the browser did not report from the forms the page tap
   * saw sent, by the same rule as response bodies: the multipart requests to a method and
   * URL from a frame pair one to one with the tapped forms (equal counts), and those forms
   * are identical. Otherwise the body stays unavailable.
   */
  private fillForms(): void {
    const superseded = new Set(this.tappedForms.flatMap((t) => (t.supersedes !== undefined ? [t.supersedes] : [])));
    const groups = new Map<string, { entries: NetworkEntry[]; forms: string[] }>();
    const group = (frame: Frame | undefined, method: string, url: string) => {
      const key = `${frame ? this.frameId(frame) : '-'} ${method} ${url}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { entries: [], forms: [] }));
      return g;
    };
    for (const e of this.entries) {
      if (multipartBoundary(e.requestHeaders['content-type']) !== undefined)
        group(this.frameOf.get(e), e.method, e.url).entries.push(e);
    }
    for (const t of this.tappedForms) {
      if (t.id !== undefined && superseded.has(t.id)) continue;
      group(t.frame, t.method, t.url).forms.push(JSON.stringify(t.fields));
    }
    for (const { entries, forms } of groups.values()) {
      const [first] = forms;
      if (first === undefined || entries.length !== forms.length || !forms.every((f) => f === first)) continue;
      // Too large to keep: the body stays unavailable rather than cut.
      if (Buffer.byteLength(first, 'utf8') > this.maxBody) continue;
      const fields = JSON.parse(first) as [string, FormValue][];
      for (const e of entries) {
        if (!e.requestBodyUnavailable) continue;
        e.requestBody = formObject(fields);
        delete e.requestBodyUnavailable;
      }
    }
  }

  private frameId(f: Frame): number {
    let id = this.frameIds.get(f);
    if (id === undefined) {
      id = ++this.frameCount;
      this.frameIds.set(f, id);
    }
    return id;
  }

  /** @internal Bodies the page tap has reported so far (for tests). */
  tappedCount(): number {
    return this.tapped.length;
  }

  /** A deep copy of the log so far. */
  log(): NetworkEntry[] {
    return structuredClone(this.entries);
  }

  /** A copy of the trajectory so far (ADR 0024); undefined when this recorder does not record one. */
  trajectory(): TrajectoryEvent[] | undefined {
    return this.events?.map((e) => ({ ...e }));
  }
}

export type Probe = () => Promise<unknown>;

export interface CaptureOptions {
  /** Network recorder; defaults to the recorder attached to the page's context, if any. */
  recorder?: EvidenceRecorder | null;
  /** Read-only backend probes, evaluated at capture time. */
  probes?: Record<string, Probe>;
  /** Capture cookies and web storage (default true). */
  storage?: boolean;
  /**
   * Capture the content of iframes (same-origin and cross-origin) under their `iframe`
   * nodes, and their text after the page's (default true; ADR 0012).
   */
  frames?: boolean;
  /**
   * Capture the browser context's other open pages (tabs, popups) as `pages`, and take the
   * active page, `page` or a popup or tab it opened, as the snapshot's page (default
   * true). false: `page` only, as before (ADR 0012).
   */
  pages?: boolean;
  /** Cookie names whose values are kept even if httpOnly or credential-like. */
  keepCookies?: string[];
  /** Web storage keys whose values are kept even if they look like credentials. */
  keepStorage?: string[];
  /**
   * State before the agent started (captureBaseline). Defaults to the last baseline
   * captured in the page's browser context, if any; null leaves it out.
   */
  baseline?: Baseline | null;
  /**
   * Take the snapshot's digest at capture time (default true; ADR 0016), so that `verify`
   * of this snapshot object does not compute it again. The snapshot is then frozen, so the
   * evidence cannot change after its digest was taken: to edit it, edit a copy
   * (`structuredClone`), or pass false. Its content and its file are unchanged.
   */
  digest?: boolean;
}

export type BaselineOptions = Pick<CaptureOptions, 'probes' | 'storage' | 'keepCookies' | 'keepStorage'>;

/**
 * Names that usually hold credentials. Values under these names, and httpOnly cookie
 * values, are redacted at capture time. Redaction goes by name only: a secret stored
 * under another name (e.g. `sid`) is kept. Pass keepCookies/keepStorage to keep one.
 */
export const CREDENTIAL_NAME = /token|secret|passw(or)?d|session|auth|jwt|bearer|api[-_]?key|credential/i;

/** Page state read inside the page: text, title, origin and web storage. */
async function readDom(page: Page) {
  return page.evaluate(() => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, must be self-contained
    const dump = (s: Storage) => {
      const o: Record<string, string> = {};
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k != null) o[k] = s.getItem(k) ?? '';
      }
      return o;
    };
    let local: Record<string, string> = {};
    let session: Record<string, string> = {};
    try {
      local = dump(window.localStorage);
      session = dump(window.sessionStorage);
    } catch {
      /* opaque origin */
    }
    return {
      text: document.body ? document.body.innerText : '',
      title: document.title,
      origin: location.origin,
      local,
      session,
    };
  });
}

async function readStorage(
  page: Page,
  dom: { origin: string; local: Record<string, string>; session: Record<string, string> },
  opts: BaselineOptions,
  redacted: string[],
): Promise<StorageRecord | null> {
  if (opts.storage === false) return null;
  const keep = new Set(opts.keepCookies ?? []);
  const cookies: CookieRecord[] = (await page.context().cookies()).map((c) => {
    const hide = (c.httpOnly || CREDENTIAL_NAME.test(c.name)) && !keep.has(c.name);
    if (hide) redacted.push(`cookie:${c.name}`);
    return {
      name: c.name,
      value: hide ? { redacted: true } : c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
    };
  });
  const keepKeys = new Set(opts.keepStorage ?? []);
  const scrub = (area: 'local' | 'session', kv: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(kv).map(([k, v]): [string, string | Redacted] => {
        if (!CREDENTIAL_NAME.test(k) || keepKeys.has(k)) return [k, v];
        redacted.push(`${area}Storage:${k}`);
        return [k, { redacted: true }];
      }),
    );
  return {
    cookies,
    local: dom.origin !== 'null' ? { [dom.origin]: scrub('local', dom.local) } : {},
    session: dom.origin !== 'null' ? { [dom.origin]: scrub('session', dom.session) } : {},
  };
}

/** Runs probes concurrently but records them in declaration order, so snapshots are reproducible. */
async function runProbes(probes: Record<string, Probe> | undefined): Promise<Record<string, ProbeResult>> {
  const entries = Object.entries(probes ?? {});
  const results = await Promise.all(
    entries.map(async ([, probe]): Promise<ProbeResult> => {
      try {
        const value = await probe();
        return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) as Json };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const out: Record<string, ProbeResult> = {};
  entries.forEach(([name], i) => (out[name] = results[i]!));
  return out;
}

/** The last baseline captured in each browser context (captureSnapshot's default). */
const baselines = new WeakMap<BrowserContext, Baseline>();

/**
 * Capture the state before the agent starts: probe results, storage and the page
 * URL. Call it once the task's starting state is set up, before the agent acts.
 * Later snapshots in the same browser context include it (unless given another
 * `baseline`), so checks can compare the end state with it (`at: "before"`).
 */
export async function captureBaseline(page: Page, opts: BaselineOptions = {}): Promise<Baseline> {
  const redacted: string[] = [];
  const dom = await readDom(page);
  const storage = await readStorage(page, dom, opts, redacted);
  const baseline: Baseline = {
    capturedAt: new Date().toISOString(),
    url: page.url(),
    storage,
    probes: await runProbes(opts.probes),
    redacted: redacted.toSorted(),
  };
  baselines.set(page.context(), baseline);
  return structuredClone(baseline);
}

/** Max ms to read one other open page; one that takes longer is recorded as unavailable. */
const PAGE_TIMEOUT = 5000;

/**
 * The active page: of `given` and the pages it opened (popups and new tabs, and the pages
 * those opened), the one that most recently opened or navigated, as the recorder saw it.
 * Pages opened otherwise (`context.newPage()`, e.g. by the test itself) never take over.
 * Without a recorder, the given page.
 */
async function activePage(given: Page, recorder: EvidenceRecorder | null | undefined): Promise<Page> {
  if (!recorder) return given;
  const open = given.context().pages();
  const openers = await Promise.all(open.map(async (p) => [p, await p.opener().catch(() => null)] as const));
  const family = new Set([given]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, opener] of openers) {
      if (opener && family.has(opener) && !family.has(p)) {
        family.add(p);
        grew = true;
      }
    }
  }
  let active = given;
  for (const p of family) {
    if (!p.isClosed() && (recorder.lastActive(p) ?? -1) > (recorder.lastActive(active) ?? -1)) active = p;
  }
  return active;
}

/**
 * Another open page: its accessibility tree (frames included) and text, or unavailable when
 * the whole read takes longer than `timeout` ms. Its title is read first and kept either
 * way, so a `page` assertion selecting it by title finds it (and abstains as unreadable).
 * @internal Exported for tests.
 */
export async function readOtherPage(p: Page, frames: boolean, timeout = PAGE_TIMEOUT): Promise<PageView> {
  let title = '';
  const read = async (): Promise<PageView> => {
    title = await p.title();
    const a11y = parseAriaSnapshot(await p.locator('body').ariaSnapshot({ timeout }));
    const texts: string[] = [];
    if (frames) await attachFrames(p.mainFrame(), a11y, texts, { ...FRAME_LIMITS, timeout });
    const text = await p.evaluate(() => (document.body ? document.body.innerText : ''));
    return { url: p.url(), title, a11y, text: [text, ...texts].join('\n') };
  };
  const view = await within(
    read().catch(() => undefined),
    timeout,
  );
  if (view && view !== TIMED_OUT) return view;
  return { url: p.url(), title, a11y: { role: 'document' }, text: '', unavailable: true };
}

/**
 * Capture a snapshot of the browser context's active page: its accessibility tree (with
 * frame content), text, URL and storage, the network log, probes and the baseline, and
 * the other open pages (tabs, popups) as `pages` (ADR 0012). The active page is `page`, or
 * a popup or tab it opened that was opened or navigated more recently.
 */
export async function captureSnapshot(page: Page, opts: CaptureOptions = {}): Promise<EvidenceSnapshot> {
  const recorder = opts.recorder === undefined ? EvidenceRecorder.for(page.context()) : opts.recorder;
  const baseline = opts.baseline === undefined ? baselines.get(page.context()) : opts.baseline;
  const redacted: string[] = [];
  const frames = opts.frames !== false;
  const active = opts.pages === false ? page : await activePage(page, recorder);

  const a11y = parseAriaSnapshot(await active.locator('body').ariaSnapshot());
  const frameTexts: string[] = [];
  if (frames) await attachFrames(active.mainFrame(), a11y, frameTexts);
  const dom = await readDom(active);
  const storage = await readStorage(active, dom, opts, redacted);
  const others =
    opts.pages === false
      ? []
      : active
          .context()
          .pages()
          .filter((p) => p !== active && !p.isClosed());
  const pages = await Promise.all(others.map((p) => readOtherPage(p, frames)));
  const probes = await runProbes(opts.probes);

  let network: NetworkEntry[] | null = null;
  let trajectory: TrajectoryEvent[] | undefined;
  if (recorder) {
    await recorder.settle();
    network = recorder.log();
    trajectory = recorder.trajectory();
  }

  const snapshot: EvidenceSnapshot = {
    schema: SNAPSHOT_SCHEMA,
    capturedAt: new Date().toISOString(),
    page: { url: active.url(), title: dom.title },
    a11y,
    // Frames' text follows the page's: innerText does not include it.
    text: [dom.text, ...frameTexts].join('\n'),
    network,
    storage,
    probes,
    // Left out (not null) when there is none, so digests of snapshots without one are unchanged.
    ...(baseline ? { baseline: structuredClone(baseline) } : {}),
    // Likewise: a snapshot of a context with one page has no `pages`.
    ...(pages.length ? { pages } : {}),
    // Likewise: only a recorder asked for the trajectory adds one (ADR 0024).
    ...(trajectory ? { trajectory } : {}),
    meta: { capturer: CAPTURER, redacted: redacted.toSorted() },
  };
  // The digest the record needs, taken now rather than on the verify path; kept beside the
  // snapshot object (not in it), so the snapshot and its file are what they always were. The
  // snapshot is frozen with it, so the digest stays the digest of its evidence.
  if (opts.digest !== false) sealDigest(snapshot);
  return snapshot;
}
