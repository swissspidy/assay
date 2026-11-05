/**
 * Request bodies as checks read them: JSON parsed, and HTML form bodies (URL-encoded and
 * multipart) parsed into an object of their fields, so a `requestBody` schema or a
 * `pointer` can match one field (ADR 0012). Files in multipart bodies are recorded by
 * name, type and size; their content is never kept.
 */
import type { FormFile, Json } from '../types.ts';

/** A form field's value: text, or a file's metadata. */
export type FormValue = string | FormFile;

/**
 * Form fields as an object; a repeated field becomes an array in field order. No
 * prototype: field names like "constructor" or "__proto__" are plain keys.
 */
export function formObject(fields: Iterable<readonly [string, FormValue]>): Record<string, Json> {
  const form = Object.create(null) as Record<string, Json>;
  for (const [k, raw] of fields) {
    const v: Json = typeof raw === 'string' ? raw : { filename: raw.filename, type: raw.type, size: raw.size };
    const prev = Object.hasOwn(form, k) ? form[k] : undefined;
    form[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return form;
}

/** The boundary parameter of a multipart/form-data content type, if it is one. */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (!contentType || !/^\s*multipart\/form-data\b/i.test(contentType)) return undefined;
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m?.[1] ?? m?.[2];
}

/** A Content-Disposition parameter (`name`, `filename`); quoted values may escape `"` and `\`. */
function dispositionParam(header: string, key: string): string | undefined {
  const re = new RegExp(`;\\s*${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, 'i');
  const m = re.exec(header);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
}

export interface ParsedMultipart {
  fields: [string, FormValue][];
  /** The body as text, with the content of file parts left out. */
  raw: string;
}

/**
 * Parse a multipart/form-data body (RFC 7578). Text parts are decoded as UTF-8. A file
 * part (one with a filename) yields its filename, content type and size. Undefined when
 * the body is not well-formed.
 */
export function parseMultipart(body: Buffer, boundary: string): ParsedMultipart | undefined {
  const delimiter = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  // A preamble before the first delimiter is ignored (RFC 2046).
  let at = body.indexOf(delimiter);
  if (at < 0) return undefined;
  const fields: [string, FormValue][] = [];
  let raw = '';
  for (;;) {
    at += delimiter.length;
    // The closing delimiter ends with "--".
    if (body[at] === 0x2d && body[at + 1] === 0x2d) {
      raw += `--${boundary}--\r\n`;
      return { fields, raw };
    }
    if (body[at] !== 0x0d || body[at + 1] !== 0x0a) return undefined;
    at += 2;
    const headEnd = body.indexOf('\r\n\r\n', at);
    if (headEnd < 0) return undefined;
    const head = body.subarray(at, headEnd).toString('utf8');
    const contentStart = headEnd + 4;
    const end = body.indexOf(next, contentStart);
    if (end < 0) return undefined;
    const headers = new Map<string, string>();
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
    const disposition = headers.get('content-disposition') ?? '';
    const name = dispositionParam(disposition, 'name');
    if (!/^\s*form-data\b/i.test(disposition) || name === undefined) return undefined;
    const filename = dispositionParam(disposition, 'filename');
    const content = body.subarray(contentStart, end);
    raw += `--${boundary}\r\n${head}\r\n\r\n`;
    if (filename !== undefined) {
      const type = headers.get('content-type') ?? 'application/octet-stream';
      fields.push([name, { filename, type, size: content.length }]);
    } else {
      const text = content.toString('utf8');
      fields.push([name, text]);
      raw += text;
    }
    raw += '\r\n';
    at = end + 2;
  }
}
