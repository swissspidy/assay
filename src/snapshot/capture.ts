import type { BrowserContext, Frame, Page, Request } from '@playwright/test';
import {
  SNAPSHOT_SCHEMA,
  type CookieRecord,
  type EvidenceSnapshot,
  type Json,
  type NetworkEntry,
  type ProbeResult,
  type StorageRecord,
} from '../types.ts';
import { parseAriaSnapshot } from './aria.ts';
import { randomUUID } from 'node:crypto';

export const CAPTURER = 'assay/0.1.0';

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

/** @internal Exported for tests. */
export function decodeBody(
  text: string,
  contentType: string | undefined,
  max: number,
): { body: Json; truncated: boolean } {
  if (text.length > max) return { body: text.slice(0, max), truncated: true };
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
    // No prototype: field names like "constructor" or "__proto__" are plain keys.
    const form = Object.create(null) as Record<string, Json>;
    for (const [k, v] of new URLSearchParams(text)) {
      const prev = Object.hasOwn(form, k) ? form[k] : undefined;
      form[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    return { body: form, truncated: false };
  }
  return { body: text, truncated: false };
}

function isTextual(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /json|text\/|xml|javascript|x-www-form-urlencoded/i.test(contentType);
}

/** Body observed inside the page by the init-script tap (see PAGE_TAP). */
interface TappedBody {
  method: string;
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
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
  const post = (method, url, status, ct, text) => {
    try { send({ token: T, method: String(method).toUpperCase(), url: String(url), status, contentType: ct || '', body: text.slice(0, MAX), truncated: text.length > MAX }); } catch {}
  };
  const origFetch = window.fetch;
  if (origFetch) {
    // The page receives the response only after the tap has read (a clone of) its body
    // and reported it. Reading concurrently would race the page: an app that navigates
    // as soon as it has the data (POST, then location.href = ...) can unload before a
    // concurrent read finishes. Streaming and oversized responses pass through untouched.
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      let method = 'GET';
      try {
        method = (init && init.method) || (input && typeof input === 'object' && 'method' in input ? input.method : 'GET');
      } catch {}
      return p.then((res) => {
        try {
          const ct = res.headers.get('content-type');
          const len = Number(res.headers.get('content-length') || 0);
          if (!textual(ct) || len > MAX) return res;
          return res.clone().text().then((t) => { post(method, res.url, res.status, ct, t); return res; }, () => res);
        } catch {
          return res;
        }
      });
    };
  }
  const X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (X) {
    const open = X.open, sendX = X.send;
    X.open = function (method) { this.__assayMethod = method; return open.apply(this, arguments); };
    X.send = function () {
      try {
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
  /** The frame that issued each entry's request, to group it with bodies tapped in that frame. */
  private readonly frameOf = new WeakMap<NetworkEntry, Frame>();
  private readonly frameIds = new WeakMap<Frame, number>();
  private frameCount = 0;
  private seq = 0;
  private readonly maxBody: number;
  private readonly bodyTimeout: number;
  private readonly token = randomUUID();

  readonly context: BrowserContext;

  private constructor(context: BrowserContext, opts: RecorderOptions) {
    this.context = context;
    this.maxBody = opts.maxBodyBytes ?? 1024 * 1024;
    this.bodyTimeout = opts.bodyTimeoutMs ?? 3000;
    context.on('request', (req) => this.onRequest(req));
    context.on('response', (resp) => this.track(this.onResponse(resp.request())));
    context.on('requestfailed', (req) => this.onFailed(req));
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
    await this.context.exposeBinding(name, (source, payload: TappedBody & { token?: string }) => {
      if (!payload || payload.token !== this.token) return;
      const { token: _t, ...body } = payload;
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
    const post = req.postData();
    if (post != null) {
      const { body, truncated } = decodeBody(post, headers['content-type'], this.maxBody);
      entry.requestBody = body;
      if (truncated) entry.bodyTruncated = true;
    }
    this.entries.push(entry);
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
      if (truncated) entry.bodyTruncated = true;
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
      if (BODY_RESOURCE_TYPES.has(e.resourceType)) group(this.frameOf.get(e), e.method, e.url).entries.push(e);
    }
    for (const t of this.tapped) group(t.frame, t.method, t.url).taps.push(t);
    for (const { entries, taps } of groups.values()) {
      const [t, ...rest] = taps;
      if (!t || entries.length !== taps.length) continue;
      const same = (x: TappedBody) =>
        x.status === t.status && x.contentType === t.contentType && x.body === t.body && x.truncated === t.truncated;
      if (!rest.every(same)) continue;
      for (const e of entries) {
        if (e.responseBody !== undefined || (e.status !== null && e.status !== t.status)) continue;
        const { body, truncated } = decodeBody(t.body, t.contentType, this.maxBody);
        e.responseBody = body;
        if (truncated || t.truncated) e.bodyTruncated = true;
      }
    }
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
}

export type Probe = () => Promise<unknown>;

export interface CaptureOptions {
  /** Network recorder; defaults to the recorder attached to the page's context, if any. */
  recorder?: EvidenceRecorder | null;
  /** Read-only backend probes, evaluated at capture time. */
  probes?: Record<string, Probe>;
  /** Capture cookies and web storage (default true). */
  storage?: boolean;
  /** Cookie names whose values are kept even if httpOnly. */
  keepCookies?: string[];
}

export async function captureSnapshot(page: Page, opts: CaptureOptions = {}): Promise<EvidenceSnapshot> {
  const recorder = opts.recorder === undefined ? EvidenceRecorder.for(page.context()) : opts.recorder;
  const redacted: string[] = [];

  const ariaYaml = await page.locator('body').ariaSnapshot();
  const domState = await page.evaluate(() => {
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

  let storage: StorageRecord | null = null;
  if (opts.storage !== false) {
    const keep = new Set(opts.keepCookies ?? []);
    const cookies: CookieRecord[] = (await page.context().cookies()).map((c) => {
      const hide = c.httpOnly && !keep.has(c.name);
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
    storage = {
      cookies,
      local: domState.origin !== 'null' ? { [domState.origin]: domState.local } : {},
      session: domState.origin !== 'null' ? { [domState.origin]: domState.session } : {},
    };
  }

  // Run probes concurrently but record them in declaration order, so snapshots are reproducible.
  const probeEntries = Object.entries(opts.probes ?? {});
  const probeResults = await Promise.all(
    probeEntries.map(async ([, probe]): Promise<ProbeResult> => {
      try {
        const value = await probe();
        return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) as Json };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const probes: Record<string, ProbeResult> = {};
  probeEntries.forEach(([name], i) => (probes[name] = probeResults[i]!));

  let network: NetworkEntry[] | null = null;
  if (recorder) {
    await recorder.settle();
    network = recorder.log();
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    capturedAt: new Date().toISOString(),
    page: { url: page.url(), title: domState.title },
    a11y: parseAriaSnapshot(ariaYaml),
    text: domState.text,
    network,
    storage,
    probes,
    meta: { capturer: CAPTURER, redacted: redacted.toSorted() },
  };
}
