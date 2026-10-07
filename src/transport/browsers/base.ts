import type { PlaywrightBrowser, BrowserContext, BrowserType, Frame, Page, Response as PlaywrightResponse } from "playwright";

import { log } from "../../core/logger.js";
import { DEFAULT_ARGS, HARMFUL_ARGS } from "../constants.js";
import type { Response } from "../utils/response.js";
import { ResponseFactory } from "../utils/page-response.js";
import { getDefaultBrowserUserAgent } from "../utils/fingerprints.js";
import { constructProxyDict, createInterceptHandler } from "../utils/navigation.js";
import { isProxyError, type ProxyType } from "../utils/proxy-rotation.js";
import {
  resolveConfig,
  resolveFetchParams,
  type FetchParams,
  type PlaywrightFetchOptions,
  type ResolvedConfig,
  type StealthSessionOptions,
} from "./config.js";
import { PageInfo, PagePool } from "./page-pool.js";

const MAX_WAIT_FOR_PAGE = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal async mutex to serialize page acquisition */
class Mutex {
  private last: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.last;
    let release!: () => void;
    this.last = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** The shared logic of browser sessions: launching, the pages pool, navigation, retries, and responses */
export abstract class BaseBrowserSession {
  readonly config: ResolvedConfig;
  readonly maxPages: number;
  readonly pagePool: PagePool;
  browser: PlaywrightBrowser | null = null;
  context: BrowserContext | null = null;
  protected contextOptions: Record<string, unknown>;
  protected browserOptions: Record<string, unknown>;
  private alive = false;
  private readonly lock = new Mutex();

  protected constructor(options: StealthSessionOptions, stealth: boolean) {
    this.config = resolveConfig(options, stealth);
    this.maxPages = this.config.maxPages;
    this.pagePool = new PagePool(this.maxPages);
    // Dark color scheme bypasses the 'prefersLightColor' check in creepjs
    this.contextOptions = { colorScheme: "dark", deviceScaleFactor: 2 };
    this.browserOptions = { args: [...DEFAULT_ARGS], ignoreDefaultArgs: [...HARMFUL_ARGS] };
  }

  /** The Playwright-compatible browser type to drive */
  protected abstract browserType(): Promise<BrowserType>;

  /** A hook that runs right after the navigation finished, before the page action */
  protected async afterNavigation(_page: Page, _params: FetchParams): Promise<void> {}

  protected isStealth(): boolean {
    return false;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  protected generateOptions(extraFlags: string[] = []): void {
    const config = this.config;
    Object.assign(this.contextOptions, {
      proxy: config.proxy ?? undefined,
      extraHTTPHeaders: config.extraHeaders ?? undefined,
    });
    if (config.timezoneId) this.contextOptions.timezoneId = config.timezoneId;
    if (config.locale && config.cdpUrl) {
      // Launch flags can't be set on remote browsers, so the detectable context option is the best effort left
      this.contextOptions.locale = config.locale;
    }
    if (config.useragent) this.contextOptions.userAgent = config.useragent;
    else if (config.headless) this.contextOptions.userAgent = getDefaultBrowserUserAgent();

    if (!config.cdpUrl) {
      let flags = [...(this.browserOptions.args as string[])];
      if (config.extraFlags.length || extraFlags.length) flags = [...new Set([...flags, ...extraFlags, ...config.extraFlags])];
      if (config.dnsOverHttps) flags.push("--dns-over-https-templates=https://cloudflare-dns.com/dns-query");
      if (config.locale) {
        // The context `locale` option patches the main thread only, so Web Workers keep the browser's real language
        // and WAFs like Cloudflare flag the mismatch. Launch flags set it browser-wide instead.
        const base = config.locale.split("-")[0]!.toLowerCase();
        const acceptLang = base !== config.locale.toLowerCase() ? `${config.locale},${base}` : config.locale;
        flags.push(`--lang=${config.locale}`, `--accept-lang=${acceptLang}`);
      }
      Object.assign(this.browserOptions, {
        args: flags,
        headless: config.headless,
        channel: config.realChrome ? "chrome" : "chromium",
      });
      if (config.executablePath) this.browserOptions.executablePath = config.executablePath;
    } else {
      this.browserOptions = {};
    }
    Object.assign(this.contextOptions, config.additionalArgs);
  }

  /** Context options with a specific proxy, used in proxy rotation mode */
  protected contextOptionsWithProxy(proxy?: ProxyType | null): Record<string, unknown> {
    const options = { ...this.contextOptions };
    if (proxy) options.proxy = constructProxyDict(proxy);
    return options;
  }

  private async initializeContext(context: BrowserContext): Promise<BrowserContext> {
    if (this.config.initScript) await context.addInitScript({ path: this.config.initScript });
    if (this.config.cookies.length) await context.addCookies(this.config.cookies);
    return context;
  }

  /** Launch the browser (or connect to it) and create the context */
  async start(): Promise<this> {
    if (this.alive || this.browser || this.context) throw new Error("Session has been already started");
    const type = await this.browserType();
    try {
      if (this.config.cdpUrl) {
        this.browser = await type.connectOverCDP(this.config.cdpUrl);
        if (!this.config.proxyRotator) this.context = await this.browser.newContext(this.contextOptions);
      } else if (this.config.proxyRotator) {
        this.browser = await type.launch(this.browserOptions);
      } else {
        this.context = await type.launchPersistentContext(this.config.userDataDir, {
          ...this.browserOptions,
          ...this.contextOptions,
        });
      }
      if (this.context) this.context = await this.initializeContext(this.context);
      this.alive = true;
      return this;
    } catch (e) {
      await this.browser?.close().catch(() => undefined);
      this.browser = null;
      this.context = null;
      throw e;
    }
  }

  /** Close every open tab in the pool, the next request opens a fresh one */
  async closePages(): Promise<void> {
    for (const info of this.pagePool.clear()) await info.page.close().catch(() => undefined);
  }

  /** Close all resources */
  async close(): Promise<void> {
    if (!this.alive) return;
    await this.closePages();
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    this.alive = false;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Statistics about the pages pool */
  getPoolStats(): { totalPages: number; busyPages: number; maxPages: number } {
    return { totalPages: this.pagePool.pagesCount, busyPages: this.pagePool.busyCount, maxPages: this.maxPages };
  }

  private async getPage(
    timeout: number,
    extraHeaders: Record<string, string> | null,
    disableResources: boolean,
    blockedDomains: Set<string> | null,
    context: BrowserContext | null = null,
  ): Promise<PageInfo> {
    return this.lock.run(async () => {
      let info = context === null ? this.pagePool.getReadyPage() : null;
      if (!info && context === null && this.pagePool.pagesCount >= this.maxPages) {
        // At max capacity, so wait for a busy page to become ready
        const start = Date.now();
        while (!info) {
          if (Date.now() - start > MAX_WAIT_FOR_PAGE) {
            throw new Error(`No pages finished to clear place in the pool within the ${MAX_WAIT_FOR_PAGE / 1000}s timeout period`);
          }
          await sleep(50);
          info = this.pagePool.getReadyPage();
        }
      }
      if (!info) {
        const ctx = context ?? this.context;
        if (!ctx) throw new Error("Browser context not initialized");
        const page = await ctx.newPage();
        info = context === null ? this.pagePool.addPage(page) : new PageInfo(page, "busy", "");
      }

      const page = info.page;
      page.setDefaultNavigationTimeout(timeout);
      page.setDefaultTimeout(timeout);
      await page.setExtraHTTPHeaders(extraHeaders ?? {});
      await page.unrouteAll({ behavior: "ignoreErrors" });
      if (disableResources || blockedDomains?.size) {
        await page.route("**/*", createInterceptHandler(disableResources, blockedDomains));
      }
      return info;
    });
  }

  protected async waitForNetworkIdle(page: Page | Frame, timeout?: number): Promise<void> {
    try {
      await page.waitForLoadState("networkidle", { timeout });
    } catch {
      // Some pages never stop making requests
    }
  }

  protected async waitForPageStability(page: Page | Frame, loadDom: boolean, networkIdle: boolean): Promise<void> {
    await page.waitForLoadState("load");
    if (loadDom) await page.waitForLoadState("domcontentloaded");
    if (networkIdle) await this.waitForNetworkIdle(page);
  }

  /** Open the URL in a tab and return the response once the page settles */
  async fetch(url: string, options: PlaywrightFetchOptions = {}): Promise<Response> {
    const { proxy: staticProxy = null, meta, ...rest } = options;
    const params = resolveFetchParams(rest, this.config, this.isStealth());
    if (!this.alive) throw new Error("The session is closed, call `start()` first");

    const headerKeys = new Set(Object.keys(params.extraHeaders ?? {}).map((key) => key.toLowerCase()));
    const referer = params.googleSearch && !headerKeys.has("referer") ? "https://www.google.com/" : undefined;
    const { retries, retryDelay, proxyRotator, captureXhr } = this.config;

    for (let attempt = 0; attempt < retries; attempt++) {
      const proxy: ProxyType | null = proxyRotator && staticProxy === null ? proxyRotator.getProxy() : staticProxy;
      let context: BrowserContext | null = null;
      let info: PageInfo | null = null;
      try {
        if (proxy) {
          // Rotation mode: a fresh context with the provided proxy
          if (!this.browser) throw new Error("Browser not initialized for proxy rotation mode");
          context = await this.initializeContext(await this.browser.newContext(this.contextOptionsWithProxy(proxy)));
        }
        info = await this.getPage(params.timeout, params.extraHeaders, params.disableResources, params.blockedDomains, context);
        return await this.navigate(info, url, params, referer, proxy, captureXhr, meta);
      } catch (error) {
        info?.markError();
        if (attempt < retries - 1) {
          const proxyLabel = typeof proxy === "string" ? proxy : JSON.stringify(proxy);
          if (proxy && isProxyError(error)) log.warning(`Proxy '${proxyLabel}' failed (attempt ${attempt + 1}) | Retrying in ${retryDelay}s...`);
          else log.warning(`Attempt ${attempt + 1} failed: ${(error as Error).message}. Retrying in ${retryDelay}s...`);
          await sleep(retryDelay * 1000);
        } else {
          log.error(`Failed after ${retries} attempts: ${(error as Error).message}`);
          throw error;
        }
      } finally {
        if (context) {
          if (info) this.pagePool.removePage(info);
          await context.close().catch(() => undefined);
        } else if (info) {
          if (info.state === "error" || info.page.isClosed()) {
            await info.page.close().catch(() => undefined);
            this.pagePool.removePage(info);
          } else {
            info.markReady();
          }
        }
      }
    }
    throw new Error("Request failed");
  }

  private async navigate(
    info: PageInfo,
    url: string,
    params: FetchParams,
    referer: string | undefined,
    proxy: ProxyType | null,
    captureXhr: string | null,
    meta: Record<string, unknown> | undefined,
  ): Promise<Response> {
    const page = info.page;
    let finalResponse: PlaywrightResponse | null = null;
    const xhrCaptured: PlaywrightResponse[] = [];
    const xhrPattern = captureXhr ? new RegExp(captureXhr) : null;
    const handler = (response: PlaywrightResponse) => {
      const request = response.request();
      if (request.resourceType() === "document" && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        finalResponse = response;
      } else if (xhrPattern && ["xhr", "fetch"].includes(request.resourceType()) && xhrPattern.test(response.url())) {
        xhrCaptured.push(response);
      }
    };
    page.on("response", handler);
    try {
      if (params.pageSetup) {
        try {
          await params.pageSetup(page);
        } catch (e) {
          log.error(`Error executing pageSetup: ${(e as Error).message}`);
        }
      }

      const firstResponse = await page.goto(url, { referer });
      await this.waitForPageStability(page, params.loadDom, params.networkIdle);
      if (!firstResponse) throw new Error(`Failed to get response for ${url}`);

      await this.afterNavigation(page, params);

      if (params.pageAction) {
        try {
          await params.pageAction(page);
        } catch (e) {
          log.error(`Error executing pageAction: ${(e as Error).message}`);
        }
      }

      if (params.waitSelector) {
        try {
          await page.locator(params.waitSelector).first().waitFor({ state: params.waitSelectorState });
          await this.waitForPageStability(page, params.loadDom, params.networkIdle);
        } catch (e) {
          log.error(`Error waiting for selector ${params.waitSelector}: ${(e as Error).message}`);
        }
      }

      await page.waitForTimeout(params.wait);
      return await ResponseFactory.fromPlaywrightResponse(page, firstResponse, finalResponse, params.selectorConfig, {
        meta: { proxy, ...(meta ?? {}) },
        xhrCaptured,
      });
    } finally {
      page.off("response", handler);
    }
  }
}
