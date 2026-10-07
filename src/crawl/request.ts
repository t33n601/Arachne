import { createHash } from "node:crypto";

import { canonicalizeUrl } from "./url-utils.js";
import type { Response } from "../transport/utils/response.js";
import { requestClassRef } from "../transport/utils/response.js";

/** What crawler callbacks can produce: scraped items (plain objects), new requests, or nothing */
export type CallbackResult = Record<string, unknown> | Request | null | undefined;

/**
 * A crawler callback. Usually an async generator method (`async *parse(response) { yield ... }`), but returning an
 * array, an iterable, a promise of either, or a single item works too. It's always called with the crawler as `this`.
 */
export type RequestCallback = (
  response: Response,
) =>
  | AsyncIterable<CallbackResult>
  | Iterable<CallbackResult>
  | Promise<CallbackResult | Iterable<CallbackResult> | void>
  | CallbackResult
  | void;

export interface RequestOptions {
  /** The id of the session that will fetch this request (the default session otherwise) */
  sid?: string;
  /** The crawler method to call with the response (`parse` by default) */
  callback?: RequestCallback | null;
  /** The higher the number, the sooner the request is processed */
  priority?: number;
  /** Allow this request even if it was done before */
  dontFilter?: boolean;
  /** Data passed along to the response's `meta` */
  meta?: Record<string, unknown>;
  /** @internal */
  _retryCount?: number;
  /** Any other option is passed to the session's fetch/request method (headers, method, data, json, proxy...) */
  [key: string]: unknown;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "function") return `<function ${val.name || "anonymous"}>`;
    if (val instanceof Uint8Array) return Buffer.from(val).toString("hex");
    if (val instanceof Set) return [...val];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return val;
  });
}

function toBytes(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf-8");
  throw new TypeError(`Can't convert ${typeof value} to bytes`);
}

export class Request {
  url: string;
  sid: string;
  callback: RequestCallback | null;
  priority: number;
  dontFilter: boolean;
  meta: Record<string, unknown>;
  /** @internal */
  _retryCount: number;
  /** Options passed to the session when fetching this request */
  sessionKwargs: Record<string, unknown>;
  /** @internal The fingerprint as a hex string, computed once */
  _fp: string | null = null;
  /** @internal Callback name kept for restoring from checkpoints */
  _callbackName: string | null = null;

  constructor(url: string, options: RequestOptions = {}) {
    const { sid = "", callback = null, priority = 0, dontFilter = false, meta, _retryCount = 0, ...kwargs } = options;
    this.url = url;
    this.sid = sid;
    this.callback = callback ?? null;
    this.priority = priority;
    this.dontFilter = dontFilter;
    this.meta = meta ? meta : {};
    this._retryCount = _retryCount;
    this.sessionKwargs = kwargs;
  }

  /** Create a copy of this request */
  copy(): Request {
    return new Request(this.url, {
      sid: this.sid,
      callback: this.callback,
      priority: this.priority,
      dontFilter: this.dontFilter,
      meta: { ...this.meta },
      _retryCount: this._retryCount,
      ...structuredCloneSafe(this.sessionKwargs),
    });
  }

  /** The network location (host[:port]) of the URL */
  get domain(): string {
    try {
      return new URL(this.url).host;
    } catch {
      return "";
    }
  }

  /** The fingerprint used for deduplication (cached after the first computation) */
  updateFingerprint(includeKwargs = false, includeHeaders = false, keepFragments = false): string {
    if (this._fp !== null) return this._fp;

    const postData = this.sessionKwargs.data;
    let body: Buffer = Buffer.alloc(0);
    if (postData) {
      if (typeof postData === "string" || postData instanceof Uint8Array) body = toBytes(postData);
      else if (postData instanceof URLSearchParams) body = Buffer.from(postData.toString());
      else if (Array.isArray(postData)) body = Buffer.from(new URLSearchParams(postData as [string, string][]).toString());
      else if (typeof postData === "object") {
        body = Buffer.from(new URLSearchParams(Object.entries(postData as Record<string, string>).map(([k, v]) => [k, String(v)])).toString());
      }
    } else if (this.sessionKwargs.json) {
      body = Buffer.from(JSON.stringify(this.sessionKwargs.json));
    }

    const data: Record<string, unknown> = {
      sid: this.sid,
      body: body.toString("hex"),
      method: this.sessionKwargs.method ?? "GET",
      url: canonicalizeUrl(this.url, keepFragments),
    };

    if (includeKwargs) {
      data.kwargs = Object.entries(this.sessionKwargs)
        .filter(([key]) => !["data", "json"].includes(key.toLowerCase()))
        .map(([key, value]) => [key.toLowerCase(), stableStringify(value)])
        .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
    }

    if (includeHeaders) {
      const headers = (this.sessionKwargs.headers ?? this.sessionKwargs.extraHeaders ?? {}) as Record<string, string>;
      data.headers = Object.entries(headers).map(([key, value]) => [toBytes(key.toLowerCase()).toString("hex"), toBytes(String(value)).toString("hex")]);
    }

    this._fp = createHash("sha1").update(stableStringify(data)).digest("hex");
    return this._fp;
  }

  /** Compare two requests by their fingerprints */
  equals(other: Request): boolean {
    if (this._fp === null || other._fp === null) throw new Error("Cannot compare requests before generating their fingerprints!");
    return this._fp === other._fp;
  }

  toString(): string {
    return this.url;
  }

  /** A JSON-safe snapshot used for checkpoints (the callback is stored by name) */
  toJSON(): Record<string, unknown> {
    return {
      url: this.url,
      sid: this.sid,
      callbackName: this.callback?.name?.replace(/^bound /, "") || this._callbackName || null,
      priority: this.priority,
      dontFilter: this.dontFilter,
      meta: this.meta,
      retryCount: this._retryCount,
      sessionKwargs: this.sessionKwargs,
      fp: this._fp,
    };
  }

  /** Rebuild a request from `toJSON()` output, the callback is restored later with `restoreCallback()` */
  static fromJSON(data: Record<string, unknown>): Request {
    const request = new Request(data.url as string, {
      sid: data.sid as string,
      priority: data.priority as number,
      dontFilter: data.dontFilter as boolean,
      meta: (data.meta as Record<string, unknown>) ?? {},
      _retryCount: (data.retryCount as number) ?? 0,
      ...((data.sessionKwargs as Record<string, unknown>) ?? {}),
    });
    request._fp = (data.fp as string) ?? null;
    request._callbackName = (data.callbackName as string) ?? null;
    return request;
  }

  /** Restore the callback from the crawler after loading a checkpoint */
  restoreCallback(crawler: object): void {
    if (this._callbackName) {
      const method = (crawler as Record<string, unknown>)[this._callbackName];
      this.callback = typeof method === "function" ? (method as RequestCallback) : ((crawler as { parse: RequestCallback }).parse ?? null);
    }
    this._callbackName = null;
  }
}

function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val && typeof val === "object" && !Array.isArray(val) && !(val instanceof Uint8Array) && Object.getPrototypeOf(val) === Object.prototype) {
      out[key] = { ...(val as Record<string, unknown>) };
    } else {
      out[key] = val;
    }
  }
  return out;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<CallbackResult> {
  return Boolean(value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function");
}

function isIterable(value: unknown): value is Iterable<CallbackResult> {
  return Boolean(
    value && typeof value === "object" && !(value instanceof Request) && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function",
  );
}

/** Normalize whatever a callback returns into an async iterable of results */
export async function* iterateCallback(output: unknown): AsyncGenerator<CallbackResult> {
  if (isAsyncIterable(output)) {
    yield* output;
    return;
  }
  const value = await output;
  if (isAsyncIterable(value)) yield* value;
  else if (isIterable(value) && !(value instanceof Map)) yield* value;
  else if (value !== undefined) yield value as CallbackResult;
}

requestClassRef.value = Request as never;
