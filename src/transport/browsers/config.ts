import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { Page } from "playwright";

import type { NodeConfig } from "../utils/response.js";
import { AD_DOMAINS } from "../utils/ad-domains.js";
import { constructProxyDict, type PlaywrightProxy } from "../utils/navigation.js";
import type { ProxyRotator, ProxyType } from "../utils/proxy-rotation.js";

export type SelectorWaitState = "attached" | "detached" | "hidden" | "visible";
export type PageLoadState = "commit" | "domcontentloaded" | "load" | "networkidle";

/** A cookie in the format Playwright accepts */
export interface SetCookieParam {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: string;
}

export type PageCallback = (page: Page) => unknown | Promise<unknown>;

/** Options of browser sessions */
export interface PlaywrightSessionOptions {
  /** The maximum number of tabs opened at the same time, used in rotation through a pool (1-50, default 1) */
  maxPages?: number;
  /** Run the browser hidden (default) or visible */
  headless?: boolean;
  /** Drop requests of unnecessary resources (fonts, images, media, stylesheets...) for a speed boost */
  disableResources?: boolean;
  /** Wait until there are no network connections for at least 500 ms */
  networkIdle?: boolean;
  /** Wait for the DOM content to load (default: true) */
  loadDom?: boolean;
  /** Wait for a CSS selector to be in a specific state */
  waitSelector?: string | null;
  /** The state to wait for with `waitSelector` (default: `attached`) */
  waitSelectorState?: SelectorWaitState;
  /** Cookies to set in the context */
  cookies?: SetCookieParam[] | null;
  /** Set a Google referer header (default: true) */
  googleSearch?: boolean;
  /** Milliseconds to wait after everything finishes before returning the response */
  wait?: number;
  /** Change the browser timezone */
  timezoneId?: string | null;
  /** A function that takes the page and runs after navigation for your automation */
  pageAction?: PageCallback | null;
  /** A function that takes the page and runs before navigation (to register listeners or routes) */
  pageSetup?: PageCallback | null;
  /** A proxy URL string or a `{server, username, password}` object */
  proxy?: ProxyType | null;
  /** Rotate proxies automatically (a new context is used per proxy) */
  proxyRotator?: ProxyRotator | null;
  /** Extra headers for every request */
  extraHeaders?: Record<string, string> | null;
  /** The timeout in milliseconds for all operations and waits (default: 30000) */
  timeout?: number;
  /** An absolute path to a JavaScript file executed on every page creation */
  initScript?: string | null;
  /** A user data directory for a persistent profile, a temporary one is used by default */
  userDataDir?: string;
  /** Parser settings for the responses */
  selectorConfig?: NodeConfig;
  /** Additional Playwright context options, these take priority over the library's settings */
  additionalArgs?: Record<string, unknown>;
  /** The user locale, e.g. `en-GB`; affects `navigator.language`, `Accept-Language`, and formatting */
  locale?: string | null;
  /** Use the installed Chrome browser instead of Chromium */
  realChrome?: boolean;
  /** Connect to an existing browser through CDP instead of launching one */
  cdpUrl?: string | null;
  /** The useragent to use, a real one matching the browser is generated otherwise */
  useragent?: string | null;
  /** Additional browser flags */
  extraFlags?: string[] | null;
  /** Domains to block, subdomains included */
  blockedDomains?: Iterable<string> | null;
  /** Block requests to ~3,500 known ad and tracker domains */
  blockAds?: boolean;
  /** Attempts per fetch (1-10, default 3) */
  retries?: number;
  /** Seconds between attempts (default 1) */
  retryDelay?: number;
  /** A regex: XHR/fetch responses with matching URLs are captured into `response.capturedXhr` */
  captureXhr?: string | null;
  /** Path to a custom Chromium-based browser executable */
  executablePath?: string | null;
  /** Resolve DNS through Cloudflare's DNS-over-HTTPS */
  dnsOverHttps?: boolean;
}

export interface StealthSessionOptions extends PlaywrightSessionOptions {
  /** Keep WebGL enabled (default: true), many WAFs check it */
  allowWebgl?: boolean;
  /** Add random noise to canvas operations to prevent fingerprinting */
  hideCanvas?: boolean;
  /** Force WebRTC to respect proxy settings to prevent local IP leaks */
  blockWebrtc?: boolean;
  /** Solve Cloudflare's Turnstile/Interstitial challenges before returning the response */
  solveCloudflare?: boolean;
}

/** Options accepted per `fetch()` call, overriding the session's */
export interface PlaywrightFetchOptions {
  loadDom?: boolean;
  wait?: number;
  networkIdle?: boolean;
  googleSearch?: boolean;
  timeout?: number;
  disableResources?: boolean;
  waitSelector?: string | null;
  pageAction?: PageCallback | null;
  pageSetup?: PageCallback | null;
  selectorConfig?: NodeConfig;
  extraHeaders?: Record<string, string> | null;
  waitSelectorState?: SelectorWaitState;
  blockedDomains?: Iterable<string> | null;
  /** A static proxy overriding the rotator/session proxy, a new context is created for it */
  proxy?: ProxyType | null;
  /** Solve Cloudflare challenges (stealth sessions only) */
  solveCloudflare?: boolean;
  /** Extra meta data attached to the response */
  meta?: Record<string, unknown>;
}

export interface ResolvedConfig {
  maxPages: number;
  headless: boolean;
  disableResources: boolean;
  networkIdle: boolean;
  loadDom: boolean;
  waitSelector: string | null;
  waitSelectorState: SelectorWaitState;
  cookies: SetCookieParam[];
  googleSearch: boolean;
  wait: number;
  timezoneId: string | null;
  pageAction: PageCallback | null;
  pageSetup: PageCallback | null;
  proxy: PlaywrightProxy | null;
  proxyRotator: ProxyRotator | null;
  extraHeaders: Record<string, string> | null;
  timeout: number;
  initScript: string | null;
  userDataDir: string;
  selectorConfig: NodeConfig;
  additionalArgs: Record<string, unknown>;
  locale: string | null;
  realChrome: boolean;
  cdpUrl: string | null;
  useragent: string | null;
  extraFlags: string[];
  blockedDomains: Set<string> | null;
  blockAds: boolean;
  retries: number;
  retryDelay: number;
  captureXhr: string | null;
  executablePath: string | null;
  dnsOverHttps: boolean;
  allowWebgl: boolean;
  hideCanvas: boolean;
  blockWebrtc: boolean;
  solveCloudflare: boolean;
}

const WAIT_STATES = new Set(["attached", "detached", "hidden", "visible"]);

function expectType(name: string, value: unknown, type: "boolean" | "number" | "string" | "function" | "object"): void {
  if (value === null || value === undefined) return;
  if (typeof value !== type) throw new TypeError(`Invalid argument type: \`${name}\` must be a ${type}, got ${typeof value}`);
}

function validateFilePath(path: string, label: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`${label} path not found: ${path}`);
  }
  if (!stats.isFile()) throw new Error(`${label} is not a file: ${path}`);
  if (!isAbsolute(path)) throw new Error(`${label} is not an absolute path: ${path}`);
}

function validateCdpUrl(url: string): void {
  if (!/^(wss?|https?):\/\//.test(url)) throw new Error("CDP URL must use 'ws://', 'wss://', 'http://', or 'https://' scheme");
  try {
    if (!new URL(url).host) throw new Error();
  } catch {
    throw new Error("Invalid hostname for the CDP URL");
  }
}

function validateCommon(options: Partial<StealthSessionOptions>): void {
  for (const key of ["headless", "disableResources", "networkIdle", "loadDom", "googleSearch", "realChrome", "blockAds", "dnsOverHttps", "allowWebgl", "hideCanvas", "blockWebrtc", "solveCloudflare"] as const) {
    expectType(key, options[key], "boolean");
  }
  for (const key of ["wait", "timeout", "retryDelay", "maxPages", "retries"] as const) {
    expectType(key, options[key], "number");
    const value = options[key];
    if (typeof value === "number" && (Number.isNaN(value) || value < 0)) throw new TypeError(`Invalid argument: \`${key}\` must be >= 0`);
  }
  for (const key of ["pageAction", "pageSetup"] as const) expectType(key, options[key], "function");
  for (const key of ["waitSelector", "timezoneId", "initScript", "userDataDir", "locale", "cdpUrl", "useragent", "captureXhr", "executablePath"] as const) {
    expectType(key, options[key], "string");
  }
  if (options.waitSelectorState !== undefined && !WAIT_STATES.has(options.waitSelectorState)) {
    throw new TypeError(`Invalid argument: \`waitSelectorState\` must be one of ${[...WAIT_STATES].join(", ")}`);
  }
  if (options.maxPages !== undefined && (options.maxPages < 1 || options.maxPages > 50)) {
    throw new TypeError("Invalid argument: `maxPages` must be between 1 and 50");
  }
  if (options.retries !== undefined && (options.retries < 1 || options.retries > 10)) {
    throw new TypeError("Invalid argument: `retries` must be between 1 and 10");
  }
  if (options.extraHeaders !== undefined && options.extraHeaders !== null && typeof options.extraHeaders !== "object") {
    throw new TypeError("Invalid argument: `extraHeaders` must be an object");
  }
  if (options.captureXhr) {
    try {
      new RegExp(options.captureXhr);
    } catch (e) {
      throw new TypeError(`Invalid argument: \`captureXhr\` is not a valid regex: ${(e as Error).message}`);
    }
  }
}

/** Validate the session options and fill in the defaults */
export function resolveConfig(options: StealthSessionOptions = {}, stealth = false): ResolvedConfig {
  validateCommon(options);
  if (options.proxy && options.proxyRotator) {
    throw new Error("Cannot use 'proxyRotator' together with 'proxy'. Use either a static proxy or proxy rotation, not both.");
  }
  if (options.cdpUrl) validateCdpUrl(options.cdpUrl);
  if (options.initScript) validateFilePath(options.initScript, "Init script");
  if (options.executablePath) validateFilePath(options.executablePath, "Browser executable");

  let blockedDomains = options.blockedDomains ? new Set(options.blockedDomains) : null;
  if (options.blockAds) blockedDomains = new Set([...(blockedDomains ?? []), ...AD_DOMAINS]);

  const config: ResolvedConfig = {
    maxPages: options.maxPages ?? 1,
    headless: options.headless ?? true,
    disableResources: options.disableResources ?? false,
    networkIdle: options.networkIdle ?? false,
    loadDom: options.loadDom ?? true,
    waitSelector: options.waitSelector ?? null,
    waitSelectorState: options.waitSelectorState ?? "attached",
    cookies: options.cookies ?? [],
    googleSearch: options.googleSearch ?? true,
    wait: options.wait ?? 0,
    timezoneId: options.timezoneId || null,
    pageAction: options.pageAction ?? null,
    pageSetup: options.pageSetup ?? null,
    proxy: options.proxy ? constructProxyDict(options.proxy) : null,
    proxyRotator: options.proxyRotator ?? null,
    extraHeaders: options.extraHeaders ?? null,
    timeout: options.timeout ?? 30000,
    initScript: options.initScript ?? null,
    userDataDir: options.userDataDir ?? "",
    selectorConfig: options.selectorConfig ?? {},
    additionalArgs: options.additionalArgs ?? {},
    locale: options.locale ?? null,
    realChrome: options.realChrome ?? false,
    cdpUrl: options.cdpUrl ?? null,
    useragent: options.useragent ?? null,
    extraFlags: options.extraFlags ?? [],
    blockedDomains,
    blockAds: options.blockAds ?? false,
    retries: options.retries ?? 3,
    retryDelay: options.retryDelay ?? 1,
    captureXhr: options.captureXhr || null,
    executablePath: options.executablePath ?? null,
    dnsOverHttps: options.dnsOverHttps ?? false,
    allowWebgl: options.allowWebgl ?? true,
    hideCanvas: options.hideCanvas ?? false,
    blockWebrtc: options.blockWebrtc ?? false,
    solveCloudflare: stealth ? (options.solveCloudflare ?? false) : false,
  };
  // Cloudflare challenges need more time
  if (config.solveCloudflare && config.timeout < 60_000) config.timeout = 60_000;
  return config;
}

export interface FetchParams {
  googleSearch: boolean;
  timeout: number;
  wait: number;
  pageAction: PageCallback | null;
  pageSetup: PageCallback | null;
  extraHeaders: Record<string, string> | null;
  disableResources: boolean;
  waitSelector: string | null;
  waitSelectorState: SelectorWaitState;
  networkIdle: boolean;
  loadDom: boolean;
  blockedDomains: Set<string> | null;
  solveCloudflare: boolean;
  selectorConfig: NodeConfig;
}

/** Merge per-call options over the session's configuration */
export function resolveFetchParams(options: PlaywrightFetchOptions, config: ResolvedConfig, stealth: boolean): FetchParams {
  validateCommon(options as Partial<StealthSessionOptions>);
  if (options.solveCloudflare && !stealth) {
    throw new Error("Solving Cloudflare challenges is only supported by stealth sessions.");
  }
  const pick = <K extends keyof FetchParams>(key: K): FetchParams[K] =>
    key in options && (options as Record<string, unknown>)[key] !== undefined
      ? ((options as Record<string, unknown>)[key] as FetchParams[K])
      : (config[key as keyof ResolvedConfig] as FetchParams[K]);

  const params: FetchParams = {
    googleSearch: pick("googleSearch"),
    timeout: pick("timeout"),
    wait: pick("wait"),
    pageAction: pick("pageAction"),
    pageSetup: pick("pageSetup"),
    extraHeaders: pick("extraHeaders"),
    disableResources: pick("disableResources"),
    waitSelector: pick("waitSelector"),
    waitSelectorState: pick("waitSelectorState"),
    networkIdle: pick("networkIdle"),
    loadDom: pick("loadDom"),
    blockedDomains: options.blockedDomains ? new Set(options.blockedDomains) : config.blockedDomains,
    solveCloudflare: pick("solveCloudflare") ?? false,
    selectorConfig: options.selectorConfig ? { ...config.selectorConfig, ...options.selectorConfig } : config.selectorConfig,
  };
  if (params.solveCloudflare && params.timeout < 60_000) params.timeout = 60_000;
  return params;
}
