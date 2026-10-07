/**
 * The HTTP engine: browser-impersonating requests (TLS/HTTP2 fingerprints of real browsers) through `impit`,
 * real browser headers, cookie sessions, retries, proxy rotation, and SSRF-safe redirects.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Impit, type Browser as ImpitBrowser } from "impit";
import { CookieJar } from "tough-cookie";

import { log } from "../core/logger.js";
import { Response, StatusText, type NodeConfig } from "./utils/response.js";
import { generateHeaders, getDefaultUserAgent } from "./utils/fingerprints.js";
import { proxyToUrl } from "./utils/navigation.js";
import { isProxyError, ProxyRotator, type ProxyType } from "./utils/proxy-rotation.js";

export type ImpersonateBrowser = ImpitBrowser | "edge" | "safari";
/** A browser to impersonate, a list to pick one randomly per request, or `null`/`false` to disable impersonation */
export type ImpersonateType = ImpersonateBrowser | ImpersonateBrowser[] | null | false;
/** `"safe"` follows redirects but rejects the ones targeting internal/private IPs (SSRF protection) */
export type FollowRedirects = boolean | "safe" | "all" | "obeycode" | "firstonly";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
export type ParamsType = Record<string, string | number | boolean | null | undefined | (string | number)[]> | [string, string | number][] | URLSearchParams;
export type DataType = Record<string, string | number | boolean> | [string, string][] | string | Uint8Array | ArrayBuffer | URLSearchParams;

export interface HttpSessionOptions {
  /** Browser to impersonate; a list picks one randomly per request (default: the latest Chrome) */
  impersonate?: ImpersonateType;
  /** Use HTTP/3 (proxies aren't supported with it) */
  http3?: boolean;
  /** Generate real browser headers and set a Google referer (default: true) */
  stealthHeaders?: boolean;
  /** Proxies per scheme, e.g. `{ http: "http://proxy:8080", https: "http://proxy:8080" }` */
  proxies?: Record<string, string>;
  /** Proxy URL, e.g. `"http://username:password@localhost:8030"` */
  proxy?: ProxyType | null;
  /** HTTP basic auth for the proxy as `[username, password]` */
  proxyAuth?: [string, string] | null;
  /** Rotate proxies automatically, can't be combined with `proxy`/`proxies` */
  proxyRotator?: ProxyRotator | null;
  /** Seconds to wait before timing out (default: 30) */
  timeout?: number;
  /** Headers sent with every request */
  headers?: Record<string, string | null | undefined>;
  /** Number of attempts on connection errors (default: 3) */
  retries?: number;
  /** Seconds to wait between attempts (default: 1) */
  retryDelay?: number;
  /** Redirects policy (default: `"safe"`) */
  followRedirects?: FollowRedirects;
  /** Maximum number of redirects, `-1` for unlimited (default: 30) */
  maxRedirects?: number;
  /** Verify HTTPS certificates (default: true) */
  verify?: boolean;
  /** Client certificate, not supported by the impersonation engine yet and ignored with a warning */
  cert?: string | [string, string] | null;
  /** Parser settings for the responses */
  selectorConfig?: NodeConfig;
}

export interface RequestOptions extends Omit<HttpSessionOptions, "proxyRotator"> {
  /** Query string parameters */
  params?: ParamsType | null;
  /** Cookies to send with this request */
  cookies?: Record<string, string> | null;
  /** HTTP basic auth as `[username, password]` */
  auth?: [string, string] | null;
  /** Form data or a raw body */
  data?: DataType | null;
  /** A JSON-serializable body */
  json?: unknown;
  /** Extra meta data attached to the response */
  meta?: Record<string, unknown>;
}

const LATEST_ALIASES: Record<string, ImpitBrowser> = {
  chrome: "chrome151",
  edge: "chrome151",
  firefox: "firefox144",
  safari: "ios18",
};
const DEFAULT_IMPERSONATE: ImpersonateBrowser = "chrome";

function selectRandomBrowser(impersonate: ImpersonateType | undefined): ImpitBrowser | null {
  let choice: ImpersonateBrowser | null | false | undefined = impersonate as ImpersonateBrowser;
  if (Array.isArray(impersonate)) {
    if (!impersonate.length) return null;
    choice = impersonate[Math.floor(Math.random() * impersonate.length)];
  }
  if (!choice) return null;
  return LATEST_ALIASES[choice] ?? (choice as ImpitBrowser);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

function buildUrl(url: string, params?: ParamsType | null): string {
  if (!params) return url;
  const target = new URL(url);
  const entries: [string, string][] = [];
  if (params instanceof URLSearchParams) {
    params.forEach((value, key) => entries.push([key, value]));
  } else if (Array.isArray(params)) {
    for (const [key, value] of params) entries.push([key, String(value)]);
  } else {
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) entries.push([key, String(item)]);
      else entries.push([key, String(value)]);
    }
  }
  for (const [key, value] of entries) target.searchParams.append(key, value);
  return target.href;
}

function encodeBody(
  data: DataType | null | undefined,
  json: unknown,
  headers: Record<string, string>,
): string | Uint8Array | undefined {
  const hasHeader = (name: string) => Object.keys(headers).some((key) => key.toLowerCase() === name);
  if (data !== null && data !== undefined) {
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    const form = data instanceof URLSearchParams ? data : new URLSearchParams();
    if (!(data instanceof URLSearchParams)) {
      const entries = Array.isArray(data) ? data : Object.entries(data);
      for (const [key, value] of entries) form.append(key, String(value));
    }
    if (!hasHeader("content-type")) headers["content-type"] = "application/x-www-form-urlencoded";
    return form.toString();
  }
  if (json !== null && json !== undefined) {
    if (!hasHeader("content-type")) headers["content-type"] = "application/json";
    return JSON.stringify(json);
  }
  return undefined;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("ff")
  );
}

/** The first line of an error message plus the OS reason if any (the HTTP engine's errors are very verbose) */
function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split("\n", 1)[0]!;
  const reason = /message: "([^"]+)"/.exec(message)?.[1] ?? /"([^"]*error[^"]*)"/i.exec(message)?.[1];
  return reason && !first.includes(reason) ? `${first} (${reason})` : first;
}

/** Raised when a "safe" redirect points to an internal/private address */
export class UnsafeRedirectError extends Error {
  override name = "UnsafeRedirectError";
}

async function assertSafeRedirect(url: string): Promise<void> {
  const { hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new UnsafeRedirectError(`Refusing to follow a redirect to an internal address: ${url}`);
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.some(isPrivateAddress)) {
    throw new UnsafeRedirectError(`Refusing to follow a redirect to an internal/private address: ${url}`);
  }
}

const CHARSET_RE = /charset=["']?([\w-]+)/i;
const META_CHARSET_RE = /<meta[^>]+charset=["']?([\w-]+)/i;

function detectEncoding(headers: Record<string, string>, body: Uint8Array): string {
  const contentType = headers["content-type"] ?? "";
  const fromHeader = CHARSET_RE.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  if (contentType.includes("html") || !contentType) {
    const head = new TextDecoder("latin1").decode(body.subarray(0, 2048));
    const fromMeta = META_CHARSET_RE.exec(head)?.[1];
    if (fromMeta) return fromMeta.toLowerCase();
  }
  return "utf-8";
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = key in out ? `${out[key]}, ${value}` : value;
  });
  return out;
}

function parseSetCookieNames(setCookies: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of setCookies) {
    const pair = line.split(";", 1)[0]!;
    const idx = pair.indexOf("=");
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

/** The request logic shared by sessions and one-off clients */
export class HttpEngine {
  protected readonly defaults: Required<
    Omit<HttpSessionOptions, "proxy" | "proxyAuth" | "proxyRotator" | "cert" | "selectorConfig" | "proxies" | "headers">
  > & {
    proxy: ProxyType | null;
    proxyAuth: [string, string] | null;
    proxies: Record<string, string>;
    headers: Record<string, string | null | undefined>;
    cert: HttpSessionOptions["cert"];
  };
  readonly selectorConfig: NodeConfig;
  protected readonly proxyRotator: ProxyRotator | null;
  /** The cookie jar of this session, `null` for one-off requests */
  protected jar: CookieJar | null = null;
  private readonly clients = new Map<string, Impit>();

  constructor(options: HttpSessionOptions = {}) {
    this.defaults = {
      impersonate: options.impersonate === undefined ? DEFAULT_IMPERSONATE : options.impersonate,
      http3: options.http3 ?? false,
      stealthHeaders: options.stealthHeaders ?? true,
      proxies: options.proxies ?? {},
      proxy: options.proxy ?? null,
      proxyAuth: options.proxyAuth ?? null,
      timeout: options.timeout ?? 30,
      headers: options.headers ?? {},
      retries: options.retries ?? 3,
      retryDelay: options.retryDelay ?? 1,
      followRedirects: options.followRedirects ?? "safe",
      maxRedirects: options.maxRedirects ?? 30,
      verify: options.verify ?? true,
      cert: options.cert ?? null,
    };
    this.selectorConfig = options.selectorConfig ?? {};
    this.proxyRotator = options.proxyRotator ?? null;
    if (this.proxyRotator && (this.defaults.proxy || Object.keys(this.defaults.proxies).length)) {
      throw new Error(
        "Cannot use 'proxyRotator' together with 'proxy' or 'proxies'. Use either a static proxy or proxy rotation, not both.",
      );
    }
  }

  /** The effective default settings of this session */
  get settings(): Record<string, unknown> {
    return { ...this.defaults };
  }

  private headersJob(requestHeaders: Record<string, string | null | undefined> | undefined, stealth: boolean, impersonating: boolean): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...this.defaults.headers, ...(requestHeaders ?? {}) })) {
      if (value !== null && value !== undefined) merged[key] = String(value);
    }
    const keys = new Set(Object.keys(merged).map((key) => key.toLowerCase()));
    if (stealth) {
      if (!keys.has("referer")) merged.referer = "https://www.google.com/";
      if (!impersonating) {
        // The impersonation engine generates the matching browser headers by itself
        for (const [key, value] of Object.entries(generateHeaders(false))) {
          if (!keys.has(key.toLowerCase())) merged[key] = value;
        }
      }
    } else if (!keys.has("user-agent") && !impersonating) {
      merged["user-agent"] = getDefaultUserAgent();
      log.debug(`Can't find useragent in headers so '${merged["user-agent"]}' was used.`);
    }
    return merged;
  }

  private resolveProxy(url: string, proxy: ProxyType | null, proxies: Record<string, string>, proxyAuth: [string, string] | null): string | undefined {
    let proxyUrl: string | undefined;
    if (proxy) proxyUrl = proxyToUrl(proxy);
    else if (Object.keys(proxies).length) {
      const scheme = new URL(url).protocol.replace(":", "");
      proxyUrl = proxies[scheme] ?? proxies.all ?? proxies.https ?? proxies.http;
    }
    if (proxyUrl && proxyAuth) {
      const parsed = new URL(proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`);
      parsed.username = encodeURIComponent(proxyAuth[0]);
      parsed.password = encodeURIComponent(proxyAuth[1]);
      proxyUrl = parsed.href.replace(/\/$/, "");
    }
    return proxyUrl;
  }

  private getClient(browser: ImpitBrowser | null, proxyUrl: string | undefined, verify: boolean, http3: boolean): Impit {
    const key = JSON.stringify([browser, proxyUrl ?? null, verify, http3]);
    let client = this.clients.get(key);
    if (!client) {
      client = new Impit({
        browser: browser ?? undefined,
        proxyUrl,
        ignoreTlsErrors: !verify,
        http3,
        followRedirects: false,
      });
      this.clients.set(key, client);
    }
    return client;
  }

  /** Forget the cached clients (and their connection pools) */
  protected resetClients(): void {
    this.clients.clear();
  }

  private async cookieHeader(url: string, extra: Record<string, string> | null | undefined, jar: CookieJar): Promise<string | undefined> {
    const parts: string[] = [];
    const fromJar = await jar.getCookieString(url);
    if (fromJar) parts.push(fromJar);
    if (extra) for (const [key, value] of Object.entries(extra)) parts.push(`${key}=${value}`);
    return parts.length ? parts.join("; ") : undefined;
  }

  /** Perform an HTTP request */
  async request(method: HttpMethod, url: string, options: RequestOptions = {}): Promise<Response> {
    const get = <K extends keyof RequestOptions>(key: K, fallback: RequestOptions[K]): RequestOptions[K] =>
      key in options && options[key] !== undefined ? options[key] : fallback;

    const selectorConfig = { ...this.selectorConfig, ...(options.selectorConfig ?? {}) };
    // Always attempt the request once; `retries` below 1 means "send it, but don't retry"
    const maxRetries = Math.max(1, Number(get("retries", this.defaults.retries)) || 1);
    const retryDelay = Number(get("retryDelay", this.defaults.retryDelay));
    const staticProxy = options.proxy ?? null;
    const stealth = Boolean(get("stealthHeaders", this.defaults.stealthHeaders));

    if (get("cert", this.defaults.cert)) {
      log.warning("The `cert` argument isn't supported by the impersonation engine yet and will be ignored.");
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let proxy: ProxyType | null;
      if (this.proxyRotator && staticProxy === null) proxy = this.proxyRotator.getProxy();
      else proxy = staticProxy ?? this.defaults.proxy;

      try {
        const response = await this.send(method, url, options, { proxy, stealth, selectorConfig });
        return response;
      } catch (error) {
        if (error instanceof UnsafeRedirectError || error instanceof TypeError) throw error;
        if (attempt < maxRetries - 1) {
          if (proxy && isProxyError(error)) {
            log.warning(`Proxy '${typeof proxy === "string" ? proxy : JSON.stringify(proxy)}' failed (attempt ${attempt + 1}) | Retrying in ${retryDelay} seconds...`);
          } else {
            log.warning(`Attempt ${attempt + 1} failed: ${shortMessage(error)}. Retrying in ${retryDelay} seconds...`);
          }
          await sleep(retryDelay);
        } else {
          log.error(`Failed after ${maxRetries} attempts: ${shortMessage(error)}`);
          throw error;
        }
      }
    }
    throw new Error("No active session available.");
  }

  private async send(
    method: HttpMethod,
    url: string,
    options: RequestOptions,
    ctx: { proxy: ProxyType | null; stealth: boolean; selectorConfig: NodeConfig },
  ): Promise<Response> {
    const get = <K extends keyof RequestOptions>(key: K, fallback: RequestOptions[K]): RequestOptions[K] =>
      key in options && options[key] !== undefined ? options[key] : fallback;

    const browser = selectRandomBrowser(get("impersonate", this.defaults.impersonate));
    const http3 = Boolean(get("http3", this.defaults.http3));
    if (http3 && browser) {
      log.warning("The argument `http3` might cause errors if used with `impersonate` argument, try switching it off if you encounter any errors.");
    }
    const timeout = Number(get("timeout", this.defaults.timeout)) * 1000;
    const verify = Boolean(get("verify", this.defaults.verify));
    const follow = get("followRedirects", this.defaults.followRedirects) as FollowRedirects;
    let maxRedirects = Number(get("maxRedirects", this.defaults.maxRedirects));
    if (follow === "firstonly") maxRedirects = 1;
    const proxyUrl = this.resolveProxy(url, ctx.proxy, get("proxies", this.defaults.proxies) ?? {}, get("proxyAuth", this.defaults.proxyAuth) ?? null);
    const client = this.getClient(browser, proxyUrl, verify, http3);
    const jar = this.jar ?? new CookieJar();

    const headers = this.headersJob(options.headers ?? undefined, ctx.stealth, Boolean(browser));
    const auth = options.auth;
    if (auth) headers.authorization = `Basic ${Buffer.from(`${auth[0]}:${auth[1]}`).toString("base64")}`;
    let body = encodeBody(options.data, options.json, headers);
    let currentMethod: HttpMethod = method;
    let currentUrl = buildUrl(url, options.params);
    const history: Response[] = [];
    const responseCookies: Record<string, string> = {};

    for (let redirects = 0; ; redirects++) {
      const requestHeaders = { ...headers };
      const cookie = await this.cookieHeader(currentUrl, options.cookies, jar);
      if (cookie) requestHeaders.cookie = cookie;
      if (body === undefined) {
        delete requestHeaders["content-type"];
      }

      const raw = await client.fetch(currentUrl, {
        method: currentMethod,
        headers: requestHeaders,
        body: body as string | Uint8Array | undefined,
        timeout,
        redirect: "manual",
      });

      const setCookies = raw.headers.getSetCookie?.() ?? [];
      for (const line of setCookies) {
        try {
          await jar.setCookie(line, currentUrl, { ignoreError: true });
        } catch {
          // Malformed cookies are ignored like browsers do
        }
      }
      Object.assign(responseCookies, parseSetCookieNames(setCookies));

      const responseHeaders = headersToRecord(raw.headers);
      const content = new Uint8Array(await raw.arrayBuffer());
      const location = raw.headers.get("location");
      const isRedirect = [301, 302, 303, 307, 308].includes(raw.status) && location;

      const build = (redirectHistory: Response[]) =>
        new Response({
          url: currentUrl,
          content,
          status: raw.status,
          reason: raw.statusText || StatusText.get(raw.status),
          encoding: detectEncoding(responseHeaders, content),
          cookies: { ...responseCookies },
          headers: responseHeaders,
          requestHeaders,
          method: currentMethod,
          history: redirectHistory,
          meta: { proxy: ctx.proxy, ...(options.meta ?? {}) },
          ...ctx.selectorConfig,
        });

      if (!isRedirect || follow === false) return build(history);
      if (maxRedirects >= 0 && redirects >= maxRedirects) {
        throw new Error(`Maximum number of redirects (${maxRedirects}) exceeded for ${url}`);
      }

      const nextUrl = new URL(location!, currentUrl).href;
      if (follow === "safe") await assertSafeRedirect(nextUrl);
      history.push(build([]));

      if (raw.status === 303 && currentMethod !== "HEAD") {
        currentMethod = "GET";
        body = undefined;
      } else if ((raw.status === 301 || raw.status === 302) && currentMethod === "POST") {
        currentMethod = "GET";
        body = undefined;
      }
      // Credentials don't follow cross-origin redirects
      if (new URL(nextUrl).origin !== new URL(currentUrl).origin) delete headers.authorization;
      currentUrl = nextUrl;
    }
  }

  get(url: string, options: Omit<RequestOptions, "data" | "json"> = {}): Promise<Response> {
    return this.request("GET", url, options);
  }

  post(url: string, options: RequestOptions = {}): Promise<Response> {
    return this.request("POST", url, options);
  }

  put(url: string, options: RequestOptions = {}): Promise<Response> {
    return this.request("PUT", url, options);
  }

  /** Careful: some websites reject a body with DELETE requests (RFC 7231 section 4.3.5) */
  delete(url: string, options: RequestOptions = {}): Promise<Response> {
    return this.request("DELETE", url, options);
  }
}

/**
 * A persistent HTTP session that keeps cookies and connections between requests.
 *
 * ```ts
 * await using session = await new HttpSession({ impersonate: "chrome" }).start();
 * const page = await session.get("https://example.com");
 * ```
 */
export class HttpSession extends HttpEngine {
  private alive = false;

  get isAlive(): boolean {
    return this.alive;
  }

  /** Open the session */
  async start(): Promise<this> {
    if (this.alive) throw new Error("This HttpSession instance already has an active session.");
    this.jar = new CookieJar();
    this.alive = true;
    return this;
  }

  /** Close the session and drop its cookies and connections */
  async close(): Promise<void> {
    this.jar = null;
    this.resetClients();
    this.alive = false;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** All the cookies stored in this session */
  async getCookies(url?: string): Promise<Record<string, string>[]> {
    if (!this.jar) return [];
    const cookies = url ? await this.jar.getCookies(url) : (await this.jar.serialize()).cookies;
    return cookies.map((cookie) => {
      const json = "toJSON" in cookie && typeof cookie.toJSON === "function" ? cookie.toJSON() : cookie;
      return json as Record<string, string>;
    });
  }

  override async request(method: HttpMethod, url: string, options: RequestOptions = {}): Promise<Response> {
    if (!this.alive) throw new Error("No active session available, call `start()` first.");
    return super.request(method, url, options);
  }
}

/** One-off client: every request gets a fresh cookie jar */
export class HttpClient extends HttpEngine {}
