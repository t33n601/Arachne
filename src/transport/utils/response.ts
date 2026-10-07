import { inspect } from "node:util";

import { ContentExtractor } from "../../core/extract.js";
import { log } from "../../core/logger.js";
import type { TrackStoreFactory } from "../../core/storage.js";
import { Node, type NodeOptions } from "../../parser.js";
import type { Request, RequestCallback } from "../../crawl/request.js";

/** Parser settings applied to every response a client creates */
export interface NodeConfig {
  hugeTree?: boolean;
  track?: boolean;
  storage?: TrackStoreFactory;
  keepCdata?: boolean;
  storageArgs?: Record<string, unknown>;
  keepComments?: boolean;
  /** Use this domain for the tracking storage instead of the response's URL */
  trackDomain?: string;
}

/** A browser cookie as Playwright returns it */
export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  [key: string]: unknown;
}

export interface ResponseInit extends NodeConfig {
  url: string;
  content: string | Uint8Array;
  status: number;
  reason: string;
  cookies: Record<string, string> | BrowserCookie[];
  headers: Record<string, string>;
  requestHeaders: Record<string, string>;
  encoding?: string;
  method?: string;
  history?: Response[];
  meta?: Record<string, unknown> | null;
}

export interface FollowOptions {
  /** The session id to use */
  sid?: string;
  /** Crawler callback to use, `null` for the crawler's `parse()` (the current request's callback when left out) */
  callback?: RequestCallback | null;
  /** The priority, the higher the number the sooner it's processed */
  priority?: number;
  /** Allow the request even if it was done before */
  dontFilter?: boolean;
  /** Additional meta data for the request */
  meta?: Record<string, unknown>;
  /** Set the current response URL as the referer of the new request (enabled by default) */
  refererFlow?: boolean;
  /** Any other session/request options */
  [key: string]: unknown;
}

/** Lazily filled reference to the crawlers' `Request` class, avoiding a circular import at load time */
export const requestClassRef: { value: (new (url: string, options?: Record<string, unknown>) => Request) | null } = {
  value: null,
};

/** The response returned by all clients: a `Node` over the page with the response details attached */
export class Response extends Node {
  status: number;
  reason: string;
  cookies: Record<string, string> | BrowserCookie[];
  headers: Record<string, string>;
  requestHeaders: Record<string, string>;
  history: Response[];
  method: string;
  meta: Record<string, unknown>;
  /** The crawler `Request` that produced this response (set by the crawler) */
  request: Request | null = null;
  /** Captured XHR/fetch responses, when `captureXhr` is set on a browser session */
  capturedXhr: Response[] = [];

  constructor(init: ResponseInit) {
    const { trackDomain, url, encoding = "utf-8", hugeTree, track, storage, keepCdata, storageArgs, keepComments } = init;
    const content = typeof init.content === "string" ? new TextEncoder().encode(init.content) : init.content;
    const selectorOptions: NodeOptions = {
      url: trackDomain || url,
      encoding,
      hugeTree,
      track,
      storage,
      keepCdata,
      storageArgs,
      keepComments,
    };
    super(content, selectorOptions);
    // The real URL is kept even when the tracking domain is used for the storage
    this.url = url;
    this.status = init.status;
    this.reason = init.reason;
    this.cookies = init.cookies;
    this.headers = init.headers;
    this.requestHeaders = init.requestHeaders;
    this.history = init.history ?? [];
    this.method = init.method ?? "GET";

    const referer = Object.entries(init.requestHeaders).find(([key]) => key.toLowerCase() === "referer")?.[1];
    log.info(`Fetched (${init.status}) <${this.method} ${url}> (referer: ${referer ?? "-"})`);

    if (init.meta && (typeof init.meta !== "object" || Array.isArray(init.meta))) {
      throw new TypeError(`Response meta should be an object but got ${typeof init.meta} instead!`);
    }
    this.meta = init.meta ?? {};
  }

  /** The raw body of the response as bytes */
  override get body(): Uint8Array {
    const raw = this._rawBody;
    return typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  }

  /** Get a response header (case-insensitive) */
  header(name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(this.headers)) if (key.toLowerCase() === lower) return value;
    return undefined;
  }

  /**
   * Convert the response content to clean Markdown. Scripts, styles, and hidden/prompt-injection content are always
   * removed first, the same cleaning the MCP server does.
   *
   * @param cssSelector Convert only the elements matching this selector (concatenated)
   * @param mainContentOnly Convert only the content inside `<body>`
   */
  markdown(cssSelector?: string | null, mainContentOnly = false): string {
    return ContentExtractor.pageToMarkdown(this, cssSelector, mainContentOnly);
  }

  /**
   * Create a crawler `Request` to follow a URL found in this page. Empty options take the values of the request that
   * produced this response (except `dontFilter`).
   */
  follow(url: string, options: FollowOptions = {}): Request {
    const RequestClass = requestClassRef.value;
    if (!RequestClass || !this.request) throw new TypeError("This response has no request set yet.");
    const { sid, callback, priority, dontFilter = false, meta, refererFlow = true, ...kwargs } = options;
    const sessionKwargs: Record<string, unknown> = { ...this.request.sessionKwargs, ...kwargs };

    if (refererFlow) {
      // For HTTP requests
      sessionKwargs.headers = { ...((sessionKwargs.headers as Record<string, string>) ?? {}), referer: this.url };
      // For browsers
      sessionKwargs.extraHeaders = { ...((sessionKwargs.extraHeaders as Record<string, string>) ?? {}), referer: this.url };
      sessionKwargs.googleSearch = false;
    }

    return new RequestClass(this.urljoin(url), {
      sid: sid || this.request.sid,
      // An explicit `callback: null` means the crawler's default `parse()`, leaving it out keeps the current callback
      callback: "callback" in options ? (callback ?? null) : this.request.callback,
      priority: priority ?? this.request.priority,
      dontFilter,
      meta: { ...this.meta, ...(meta ?? {}) },
      ...sessionKwargs,
    });
  }

  override toString(): string {
    return `<${this.status} ${this.url}>`;
  }

  override [inspect.custom](): string {
    return this.toString();
  }
}

/** The base of the one-off clients holding the parser's settings, set globally with `configure()` */
export class BaseClient {
  static hugeTree = true;
  static track = false;
  static storage: TrackStoreFactory | undefined = undefined;
  static keepCdata = false;
  static storageArgs: Record<string, unknown> | undefined = undefined;
  static keepComments = false;
  static trackDomain = "";
  static readonly parserKeywords = [
    "hugeTree",
    "track",
    "storage",
    "keepCdata",
    "storageArgs",
    "keepComments",
    "trackDomain",
  ] as const;

  static displayConfig(): NodeConfig {
    return {
      hugeTree: this.hugeTree,
      keepComments: this.keepComments,
      keepCdata: this.keepCdata,
      track: this.track,
      storage: this.storage,
      storageArgs: this.storageArgs,
      trackDomain: this.trackDomain,
    };
  }

  /** Set the parser's arguments globally for this client */
  static configure(options: NodeConfig): void {
    const keys = Object.keys(options);
    if (!keys.length) {
      throw new Error(`You must pass a keyword to configure, current keywords: ${this.parserKeywords.join(", ")}`);
    }
    for (const key of keys) {
      if (!(this.parserKeywords as readonly string[]).includes(key)) {
        throw new Error(`Unknown parser argument: "${key}"; maybe you meant ${this.parserKeywords.join(", ")}?`);
      }
      (this as unknown as Record<string, unknown>)[key] = (options as Record<string, unknown>)[key];
    }
  }

  /** The parser arguments merged with the given per-call configuration (which takes priority) */
  static generateParserArguments(overrides: NodeConfig = {}): NodeConfig {
    return { ...this.displayConfig(), ...overrides };
  }
}

/** HTTP status codes' reason phrases. Reference: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status */
const STATUS_PHRASES: Readonly<Record<number, string>> = Object.freeze({
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
});

export const StatusText = {
  get(statusCode: number): string {
    return STATUS_PHRASES[statusCode] ?? "Unknown Status Code";
  },
};
