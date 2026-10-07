/** The MCP server exposing the clients as tools for AI agents */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { ContentExtractor, CONTROL_CHARS_RE, type ExtractionType } from "../core/extract.js";
import { rootLogger as log, consoleHandler, makeFormatter } from "../core/logger.js";
import { VERSION } from "../version.js";
import { BaseBrowserSession } from "../transport/browsers/base.js";
import type { PlaywrightFetchOptions } from "../transport/browsers/config.js";
import { BrowserSession } from "../transport/browsers/browser.js";
import { StealthBrowserSession } from "../transport/browsers/stealth.js";
import { HttpSession, type HttpMethod, type RequestOptions } from "../transport/http.js";
import type { Response } from "../transport/utils/response.js";

export const MCP_EXECUTABLE_PATH_ENV = "ARACHNE_EXECUTABLE_PATH";
export const MCP_AUTH_TOKEN_ENV = "ARACHNE_MCP_AUTH_TOKEN";
const MAX_POOL_PAGES = 50;

type SessionType = "dynamic" | "stealth" | "static";

interface SessionEntry {
  session: HttpSession | BaseBrowserSession;
  type: SessionType;
  createdAt: string;
}

export interface ResponseModel {
  status: number;
  content: string[];
  url: string;
}

const responseShape = {
  status: z.number().describe("The status code returned by the website."),
  content: z.array(z.string()).describe("The content as Markdown/HTML or the text content of the page."),
  url: z.string().describe("The URL given by the user that resulted in this response."),
};
const sessionInfoShape = {
  session_id: z.string(),
  session_type: z.enum(["dynamic", "stealth", "static"]),
  created_at: z.string(),
  is_alive: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
};

// Shared input schemas
const extraction = {
  extraction_type: z.enum(["markdown", "html", "text"]).default("markdown").describe('"markdown" (default), "html", or "text".'),
  css_selector: z.string().optional().describe("CSS selector to extract only the matching elements, all matches are returned."),
  main_content_only: z.boolean().default(true).describe("Return only the content inside the page's <body> tag (default: true)."),
};
const httpOptions = {
  impersonate: z
    .union([z.string(), z.array(z.string())])
    .default("chrome")
    .describe("Browser to impersonate its TLS fingerprint, or a list to pick randomly. The latest Chrome by default."),
  params: z.record(z.string(), z.string()).optional().describe("Query string parameters."),
  headers: z.record(z.string(), z.string()).optional().describe("Headers to include in the request."),
  cookies: z.record(z.string(), z.string()).optional().describe("Cookies to use in the request."),
  timeout: z.number().default(30).describe("Seconds to wait before timing out."),
  follow_redirects: z
    .union([z.boolean(), z.literal("safe")])
    .default("safe")
    .describe('Defaults to "safe", which rejects redirects to internal/private IPs. Pass true to follow all redirects.'),
  max_redirects: z.number().default(30).describe("Maximum number of redirects, -1 for unlimited."),
  retries: z.number().default(3).describe("Number of retry attempts."),
  retry_delay: z.number().default(1).describe("Seconds to wait between retry attempts."),
  auth: z.object({ username: z.string(), password: z.string() }).optional().describe("HTTP basic auth credentials."),
  verify: z.boolean().default(true).describe("Verify HTTPS certificates."),
  http3: z.boolean().default(false).describe("Use HTTP/3, might be problematic with impersonation."),
  stealth_headers: z.boolean().default(true).describe("Create and add real browser headers and a Google referer."),
};
const oneShotHttpOptions = {
  ...httpOptions,
  proxy: z.string().optional().describe('Proxy URL, e.g. "http://username:password@localhost:8030".'),
  proxy_auth: z.object({ username: z.string(), password: z.string() }).optional().describe("HTTP basic auth for the proxy."),
};
const dataOptions = {
  data: z.union([z.record(z.string(), z.string()), z.string()]).optional().describe("Form data or a raw body."),
  json: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional().describe("A JSON body."),
};
const waitOptions = {
  wait: z.number().default(0).describe("Milliseconds to wait after the page loads before returning."),
  timeout: z.number().default(30000).describe("Timeout in milliseconds for page operations."),
  network_idle: z.boolean().default(false).describe("Wait until there are no network connections for at least 500 ms."),
  wait_selector: z.string().optional().describe("CSS selector to wait for before returning."),
  wait_selector_state: z.enum(["attached", "detached", "hidden", "visible"]).default("attached"),
  disable_resources: z.boolean().default(false).describe("Drop requests of fonts, images, media, stylesheets, etc. for speed."),
  google_search: z.boolean().default(true).describe("Set a Google referer header."),
  extra_headers: z.record(z.string(), z.string()).optional().describe("Extra headers to add to the requests."),
};
const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  url: z.string().optional(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});
const browserOptions = {
  headless: z.boolean().default(true).describe("Run the browser hidden (default) or visible."),
  real_chrome: z.boolean().default(false).describe("Use the installed Chrome browser."),
  proxy: z
    .union([z.string(), z.object({ server: z.string(), username: z.string().optional(), password: z.string().optional() })])
    .optional()
    .describe("A proxy URL or {server, username, password}."),
  timezone_id: z.string().optional().describe("Browser timezone, the system's by default."),
  locale: z.string().optional().describe("User locale, e.g. en-GB."),
  useragent: z.string().optional().describe("Useragent to use, a real one is generated otherwise."),
  cdp_url: z.string().optional().describe("Connect to a browser through this CDP URL instead of launching one."),
  executable_path: z.string().optional().describe("Absolute path to a Chromium-based browser executable."),
  cookies: z.array(cookieSchema).optional().describe("Cookies to set, in Playwright's format."),
};
const stealthOptions = {
  hide_canvas: z.boolean().default(false).describe("Add random noise to canvas operations to prevent fingerprinting."),
  block_webrtc: z.boolean().default(false).describe("Force WebRTC to respect the proxy to prevent local IP leaks."),
  allow_webgl: z.boolean().default(true).describe("Keep WebGL enabled, many WAFs check it."),
  solve_cloudflare: z.boolean().default(false).describe("Solve Cloudflare Turnstile/Interstitial challenges."),
  additional_args: z.record(z.string(), z.unknown()).optional().describe("Additional Playwright context options."),
};

const FETCH_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };
const SESSION_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const LIST_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false };

const INSTRUCTIONS = `Follow these instructions precisely:
1. When the \`open_session\` or \`open_http_session\` tools are used, close the session with \`close_session\` after you finish, and use \`list_sessions\` if you lose track of the open sessions or their settings.
2. If the user didn't specify which tool to use, start with \`http_request\` (a plain HTTP request, GET by default; set \`method\` for POST/PUT/DELETE), then escalate. \`http_request\` and \`bulk_http_request\` suit low-to-mid protection levels only. For high protection or websites that need JavaScript, use the browser tools directly.
3. For all tools, if \`css_selector\` matches more than one element, all of them are returned.
4. \`extraction_type\` controls the returned format: "markdown" (default), "html", or "text".
5. \`main_content_only\` is enabled by default and returns only the content inside <body>. Pass false for the full page.
6. For several sequential requests to the same website, open a session once and fetch through it: \`open_session\` + \`session_browser_fetch\` for browsers, or \`open_http_session\` + \`session_http_request\` for plain HTTP.
7. Sessions hold the session-level configuration; \`session_browser_fetch\`/\`session_http_request\` carry the per-request options. The one-shot tools never touch sessions.
8. For multiple parallel one-shot requests, use the bulk version of the tool.
9. When crawling, use \`css_selector\` to only get the parts you need and save time/money, e.g. \`a\` to extract the links.
10. A CDP URL can be passed to \`open_session\` to control a remote browser.`;

function credentials(value?: { username: string; password: string }): [string, string] | null {
  return value ? [value.username, value.password] : null;
}

function translate(page: Response, extractionType: ExtractionType, cssSelector: string | undefined, mainContentOnly: boolean): ResponseModel {
  const content = [...ContentExtractor.extractContent(page, extractionType, cssSelector, mainContentOnly)].map((chunk) =>
    chunk.replace(CONTROL_CHARS_RE, ""),
  );
  return { status: page.status, content, url: page.url };
}

function structured<T extends object>(data: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
}

function sessionSettings(session: HttpSession | BaseBrowserSession): Record<string, unknown> {
  const raw: Record<string, unknown> = session instanceof HttpSession ? session.settings : session.config.cdpUrl ? {} : { ...session.config };
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value)),
  );
}

function poolSize(urls: string[]): number {
  return Math.min(Math.max(urls.length, 1), MAX_POOL_PAGES);
}

type Args<T extends z.ZodRawShape> = z.infer<z.ZodObject<T>>;

/** Holds the open sessions and implements every tool */
export class ArachneMcpServer {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly executablePath: string | null;
  private readonly authToken: string | null;

  /**
   * @param executablePath Default Chromium-compatible executable for the browser tools (or `ARACHNE_EXECUTABLE_PATH`)
   * @param authToken Shared bearer token required on the HTTP transport (or `ARACHNE_MCP_AUTH_TOKEN`)
   */
  constructor(options: { executablePath?: string | null; authToken?: string | null } = {}) {
    this.executablePath = options.executablePath || process.env[MCP_EXECUTABLE_PATH_ENV] || null;
    this.authToken = options.authToken || process.env[MCP_AUTH_TOKEN_ENV] || null;
  }

  private getSession(sessionId: string, expected: SessionType | null): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session '${sessionId}' not found. Use list_sessions to see active sessions.`);
    if (!entry.session.isAlive) throw new Error(`Session '${sessionId}' is no longer alive. Open a new session.`);
    if (expected && entry.type !== expected) {
      throw new Error(
        `Session '${sessionId}' is a '${entry.type}' session, but this tool requires a '${expected}' session. Use the matching fetch tool for your session type.`,
      );
    }
    return entry;
  }

  private newSessionId(sessionId?: string): string {
    const id = sessionId || randomBytes(6).toString("hex");
    if (this.sessions.has(id)) throw new Error(`Session '${id}' already exists. Use a different ID or close the existing session first.`);
    return id;
  }

  private register(id: string, session: HttpSession | BaseBrowserSession, type: SessionType) {
    const entry: SessionEntry = { session, type, createdAt: new Date().toISOString() };
    this.sessions.set(id, entry);
    return {
      session_id: id,
      session_type: type,
      created_at: entry.createdAt,
      is_alive: true,
      settings: sessionSettings(session),
      message: `Session '${id}' (${type}) created successfully.`,
    };
  }

  private httpRequestOptions(args: Partial<Args<typeof oneShotHttpOptions>>, method: HttpMethod, data?: Args<typeof dataOptions>): RequestOptions {
    const options: RequestOptions = {
      auth: credentials(args.auth),
      http3: args.http3,
      verify: args.verify,
      params: args.params,
      headers: args.headers,
      cookies: args.cookies,
      timeout: args.timeout,
      retries: args.retries,
      retryDelay: args.retry_delay,
      impersonate: args.impersonate as RequestOptions["impersonate"],
      maxRedirects: args.max_redirects,
      followRedirects: args.follow_redirects,
      stealthHeaders: args.stealth_headers,
    };
    if (args.proxy) options.proxy = args.proxy;
    if (args.proxy_auth) options.proxyAuth = credentials(args.proxy_auth);
    if (method !== "GET" && data) {
      options.data = data.data;
      options.json = data.json;
    }
    return options;
  }

  private browserSessionOptions(args: Partial<Args<typeof browserOptions> & Args<typeof stealthOptions>>) {
    return {
      proxy: args.proxy,
      locale: args.locale,
      cookies: args.cookies,
      cdpUrl: args.cdp_url,
      headless: args.headless,
      blockAds: true,
      useragent: args.useragent,
      timezoneId: args.timezone_id,
      realChrome: args.real_chrome,
      executablePath: args.executable_path || this.executablePath,
    };
  }

  async makeRequest(args: Args<typeof oneShotHttpOptions> & Args<typeof dataOptions> & Args<typeof extraction> & { url: string; method: HttpMethod }): Promise<ResponseModel> {
    const session = await new HttpSession().start();
    try {
      const page = await session.request(args.method, args.url, this.httpRequestOptions(args, args.method, args));
      return translate(page, args.extraction_type, args.css_selector, args.main_content_only);
    } finally {
      await session.close();
    }
  }

  async bulkGet(args: Args<typeof oneShotHttpOptions> & Args<typeof extraction> & { urls: string[] }): Promise<ResponseModel[]> {
    const session = await new HttpSession().start();
    try {
      const pages = await Promise.all(args.urls.map((url) => session.get(url, this.httpRequestOptions(args, "GET"))));
      return pages.map((page) => translate(page, args.extraction_type, args.css_selector, args.main_content_only));
    } finally {
      await session.close();
    }
  }

  async bulkFetch(
    args: Args<typeof browserOptions> & Partial<Args<typeof stealthOptions>> & Args<typeof waitOptions> & Args<typeof extraction> & { urls: string[] },
    stealth: boolean,
  ): Promise<ResponseModel[]> {
    const options = {
      ...this.browserSessionOptions(args),
      wait: args.wait,
      timeout: args.timeout,
      maxPages: poolSize(args.urls),
      networkIdle: args.network_idle,
      waitSelector: args.wait_selector,
      googleSearch: args.google_search,
      extraHeaders: args.extra_headers,
      disableResources: args.disable_resources,
      waitSelectorState: args.wait_selector_state,
    };
    const session = stealth
      ? new StealthBrowserSession({
          ...options,
          hideCanvas: args.hide_canvas,
          allowWebgl: args.allow_webgl,
          blockWebrtc: args.block_webrtc,
          solveCloudflare: args.solve_cloudflare,
          additionalArgs: args.additional_args,
        })
      : new BrowserSession(options);
    await session.start();
    try {
      const pages = await Promise.all(args.urls.map((url) => session.fetch(url)));
      return pages.map((page) => translate(page, args.extraction_type, args.css_selector, args.main_content_only));
    } finally {
      await session.close();
    }
  }

  async openSession(args: Args<typeof browserOptions> & Partial<Args<typeof stealthOptions>> & { session_type: "dynamic" | "stealth"; session_id?: string }) {
    const id = this.newSessionId(args.session_id);
    const common = this.browserSessionOptions(args);
    const session =
      args.session_type === "stealth"
        ? new StealthBrowserSession({
            ...common,
            hideCanvas: args.hide_canvas,
            blockWebrtc: args.block_webrtc,
            allowWebgl: args.allow_webgl,
            additionalArgs: args.additional_args,
          })
        : new BrowserSession(common);
    await session.start();
    return this.register(id, session, args.session_type);
  }

  async openRequestSession(args: { session_id?: string; impersonate: string | string[]; proxy?: string }) {
    const id = this.newSessionId(args.session_id);
    const session = await new HttpSession({ impersonate: args.impersonate as RequestOptions["impersonate"], proxy: args.proxy }).start();
    return this.register(id, session, "static");
  }

  async closeSession(sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session '${sessionId}' not found. Use list_sessions to see active sessions.`);
    this.sessions.delete(sessionId);
    await entry.session.close();
    return { session_id: sessionId, message: `Session '${sessionId}' closed successfully.` };
  }

  listSessions() {
    return [...this.sessions].map(([id, entry]) => ({
      session_id: id,
      session_type: entry.type,
      created_at: entry.createdAt,
      is_alive: entry.session.isAlive,
      settings: sessionSettings(entry.session),
    }));
  }

  async sessionFetch(args: Args<typeof waitOptions> & Args<typeof extraction> & { url: string; session_id: string; load_dom: boolean; blocked_domains?: string[]; solve_cloudflare: boolean }) {
    const entry = this.getSession(args.session_id, null);
    if (entry.type === "static") throw new Error(`Session '${args.session_id}' is a 'static' session. Use \`session_http_request\` with it instead.`);
    if (args.solve_cloudflare && entry.type !== "stealth") {
      throw new Error(`Session '${args.session_id}' is a '${entry.type}' session, so it can't solve Cloudflare challenges. Open a 'stealth' session for that.`);
    }
    const options: PlaywrightFetchOptions = {
      wait: args.wait,
      timeout: args.timeout,
      googleSearch: args.google_search,
      networkIdle: args.network_idle,
      loadDom: args.load_dom,
      disableResources: args.disable_resources,
      waitSelector: args.wait_selector,
      waitSelectorState: args.wait_selector_state,
      extraHeaders: args.extra_headers,
      blockedDomains: args.blocked_domains,
    };
    if (entry.type === "stealth") options.solveCloudflare = args.solve_cloudflare;
    const page = await (entry.session as BaseBrowserSession).fetch(args.url, options);
    return translate(page, args.extraction_type, args.css_selector, args.main_content_only);
  }

  async sessionMakeRequest(args: Args<typeof httpOptions> & Args<typeof dataOptions> & Args<typeof extraction> & { url: string; session_id: string; method: HttpMethod }) {
    const entry = this.getSession(args.session_id, "static");
    const { impersonate: _ignored, ...rest } = args;
    const options = this.httpRequestOptions(rest, args.method, args);
    delete options.impersonate;
    const page = await (entry.session as HttpSession).request(args.method, args.url, options);
    return translate(page, args.extraction_type, args.css_selector, args.main_content_only);
  }

  async screenshot(args: {
    url: string;
    session_id: string;
    image_type: "png" | "jpeg";
    full_page: boolean;
    quality?: number;
    wait: number;
    wait_selector?: string;
    wait_selector_state: "attached" | "detached" | "hidden" | "visible";
    network_idle: boolean;
    timeout: number;
  }) {
    if (args.quality !== undefined && args.image_type !== "jpeg") throw new Error("'quality' is only valid when 'image_type' is 'jpeg'.");
    const entry = this.getSession(args.session_id, null);
    if (entry.type === "static") {
      throw new Error(`Session '${args.session_id}' is a 'static' session, so it can't take screenshots. Open a 'dynamic' or 'stealth' session for that.`);
    }
    const captured: { bytes?: Buffer; url?: string; error?: unknown } = {};
    await (entry.session as BaseBrowserSession).fetch(args.url, {
      wait: args.wait,
      timeout: args.timeout,
      networkIdle: args.network_idle,
      waitSelector: args.wait_selector,
      waitSelectorState: args.wait_selector_state,
      pageAction: async (page) => {
        try {
          captured.bytes = await page.screenshot({ type: args.image_type, fullPage: args.full_page, quality: args.quality });
          captured.url = page.url();
        } catch (e) {
          captured.error = e;
        }
      },
    });
    if (captured.error) throw captured.error;
    if (!captured.bytes) throw new Error(`Failed to capture screenshot for ${args.url}`);
    return {
      content: [
        { type: "image" as const, data: captured.bytes.toString("base64"), mimeType: `image/${args.image_type}` },
        { type: "text" as const, text: captured.url ?? args.url },
      ],
    };
  }

  /** Build an MCP server with every tool registered */
  buildServer(): McpServer {
    const server = new McpServer({ name: "Arachne", version: VERSION, title: "Arachne" }, { instructions: INSTRUCTIONS });
    const responseOutput = responseShape;
    const listOutput = { result: z.array(z.object(responseShape)) };

    server.registerTool(
      "open_session",
      {
        title: "open_session",
        description:
          "Open a persistent browser session reused across multiple `session_browser_fetch` calls, avoiding a browser launch per request. Sessions hold the browser-level configuration only. Use \"dynamic\" for a standard browser or \"stealth\" for anti-bot bypass.",
        inputSchema: {
          session_type: z.enum(["dynamic", "stealth"]),
          session_id: z.string().optional().describe("Optional custom session ID, a random one is generated otherwise."),
          ...browserOptions,
          hide_canvas: stealthOptions.hide_canvas,
          block_webrtc: stealthOptions.block_webrtc,
          allow_webgl: stealthOptions.allow_webgl,
          additional_args: stealthOptions.additional_args,
        },
        outputSchema: { ...sessionInfoShape, message: z.string() },
        annotations: SESSION_ANNOTATIONS,
      },
      async (args) => structured(await this.openSession(args)),
    );

    server.registerTool(
      "open_http_session",
      {
        title: "open_http_session",
        description:
          "Open a persistent HTTP session (no browser) reused across `session_http_request` calls, keeping cookies, connections, and the browser fingerprint. It shows in `list_sessions` as a 'static' session.",
        inputSchema: {
          session_id: z.string().optional(),
          impersonate: httpOptions.impersonate,
          proxy: z.string().optional().describe('Proxy URL used for every request, e.g. "http://username:password@localhost:8030".'),
        },
        outputSchema: { ...sessionInfoShape, message: z.string() },
        annotations: SESSION_ANNOTATIONS,
      },
      async (args) => structured(await this.openRequestSession(args)),
    );

    server.registerTool(
      "close_session",
      {
        title: "close_session",
        description: "Close a persistent session and free its resources.",
        inputSchema: { session_id: z.string() },
        outputSchema: { session_id: z.string(), message: z.string() },
        annotations: SESSION_ANNOTATIONS,
      },
      async ({ session_id }) => structured(await this.closeSession(session_id)),
    );

    server.registerTool(
      "list_sessions",
      {
        title: "list_sessions",
        description: "List all active sessions with their details, including the effective settings each one was created with.",
        outputSchema: { result: z.array(z.object(sessionInfoShape)) },
        annotations: LIST_ANNOTATIONS,
      },
      async () => structured({ result: this.listSessions() }),
    );

    server.registerTool(
      "http_request",
      {
        title: "http_request",
        description:
          "Make an HTTP request (GET, POST, PUT, DELETE) to a URL with browser impersonation and return a structured output. Only suitable for low-mid protection levels.",
        inputSchema: {
          url: z.string(),
          method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
          ...extraction,
          ...oneShotHttpOptions,
          ...dataOptions,
        },
        outputSchema: responseOutput,
        annotations: FETCH_ANNOTATIONS,
      },
      async (args) => structured(await this.makeRequest(args)),
    );

    server.registerTool(
      "bulk_http_request",
      {
        title: "bulk_http_request",
        description: "Make GET requests to a group of URLs in parallel and return a structured output for each. Only suitable for low-mid protection levels.",
        inputSchema: { urls: z.array(z.string()), ...extraction, ...oneShotHttpOptions },
        outputSchema: listOutput,
        annotations: FETCH_ANNOTATIONS,
      },
      async (args) => structured({ result: await this.bulkGet(args) }),
    );

    const fetchInput = { ...extraction, ...browserOptions, ...waitOptions };
    server.registerTool(
      "browser_fetch",
      {
        title: "browser_fetch",
        description: "Open a browser (Playwright) to fetch a URL and return a structured output. Only suitable for low-mid protection levels.",
        inputSchema: { url: z.string(), ...fetchInput },
        outputSchema: responseOutput,
        annotations: FETCH_ANNOTATIONS,
      },
      async ({ url, ...args }) => structured((await this.bulkFetch({ ...args, urls: [url] }, false))[0]!),
    );
    server.registerTool(
      "bulk_browser_fetch",
      {
        title: "bulk_browser_fetch",
        description: "Open a browser to fetch a group of URLs at the same time (one tab each) and return a structured output for each page.",
        inputSchema: { urls: z.array(z.string()), ...fetchInput },
        outputSchema: listOutput,
        annotations: FETCH_ANNOTATIONS,
      },
      async (args) => structured({ result: await this.bulkFetch(args, false) }),
    );

    const stealthInput = { ...fetchInput, ...stealthOptions };
    server.registerTool(
      "stealth_fetch",
      {
        title: "stealth_fetch",
        description: "Fetch a URL with the stealth browser and return a structured output. The only client suitable for high-protection websites.",
        inputSchema: { url: z.string(), ...stealthInput },
        outputSchema: responseOutput,
        annotations: FETCH_ANNOTATIONS,
      },
      async ({ url, ...args }) => structured((await this.bulkFetch({ ...args, urls: [url] }, true))[0]!),
    );
    server.registerTool(
      "bulk_stealth_fetch",
      {
        title: "bulk_stealth_fetch",
        description: "Fetch a group of URLs at the same time with the stealth browser and return a structured output for each page.",
        inputSchema: { urls: z.array(z.string()), ...stealthInput },
        outputSchema: listOutput,
        annotations: FETCH_ANNOTATIONS,
      },
      async (args) => structured({ result: await this.bulkFetch(args, true) }),
    );

    server.registerTool(
      "session_browser_fetch",
      {
        title: "session_browser_fetch",
        description:
          "Fetch a URL through a browser session opened with `open_session` and return a structured output. Every option here applies to this request only.",
        inputSchema: {
          url: z.string(),
          session_id: z.string(),
          ...extraction,
          ...waitOptions,
          load_dom: z.boolean().default(true),
          blocked_domains: z.array(z.string()).optional().describe("Domains to block, subdomains included."),
          solve_cloudflare: stealthOptions.solve_cloudflare,
        },
        outputSchema: responseOutput,
        annotations: FETCH_ANNOTATIONS,
      },
      async (args) => structured(await this.sessionFetch(args)),
    );

    server.registerTool(
      "session_http_request",
      {
        title: "session_http_request",
        description:
          "Make an HTTP request (GET, POST, PUT, DELETE) through a session opened with `open_http_session`, keeping its cookies, connections, and fingerprint. Every option here applies to this request only.",
        inputSchema: {
          url: z.string(),
          session_id: z.string(),
          method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
          ...extraction,
          ...httpOptions,
          ...dataOptions,
        },
        outputSchema: responseOutput,
        annotations: FETCH_ANNOTATIONS,
      },
      async (args) => structured(await this.sessionMakeRequest(args)),
    );

    server.registerTool(
      "screenshot",
      {
        title: "screenshot",
        description: "Capture a screenshot of a web page through a browser session opened with `open_session` and return it as an image.",
        inputSchema: {
          url: z.string(),
          session_id: z.string(),
          image_type: z.enum(["png", "jpeg"]).default("png"),
          full_page: z.boolean().default(false).describe("Capture the full scrollable page instead of the viewport."),
          quality: z.number().min(0).max(100).optional().describe("JPEG quality (0-100), JPEG only."),
          wait: waitOptions.wait,
          wait_selector: waitOptions.wait_selector,
          wait_selector_state: waitOptions.wait_selector_state,
          network_idle: waitOptions.network_idle,
          timeout: waitOptions.timeout,
        },
        annotations: FETCH_ANNOTATIONS,
      },
      async (args) => this.screenshot(args),
    );
    return server;
  }

  /** Close every open session */
  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id).catch(() => undefined);
  }

  /**
   * Serve the MCP server over stdio (default) or streamable HTTP. Over HTTP, a bearer token is required unless
   * `allowUnauthenticated` is explicitly set.
   */
  async serve(options: { http?: boolean; host?: string; port?: number; allowedHosts?: string[]; allowUnauthenticated?: boolean } = {}): Promise<void> {
    const { http = false, host = "127.0.0.1", port = 8000, allowedHosts = [], allowUnauthenticated = false } = options;
    // stdout belongs to the protocol on stdio, so logs go to stderr (they already do)
    log.handlers = [consoleHandler(makeFormatter())];

    if (!http) {
      if (this.authToken) log.warning("The authentication token only applies to the streamable-http transport, so it's ignored with stdio.");
      const server = this.buildServer();
      await server.connect(new StdioServerTransport());
      const shutdown = async () => {
        await this.closeAll();
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return;
    }

    if (this.authToken) {
      if (allowUnauthenticated) log.warning("An authentication token was given, so it takes precedence and the server still requires it.");
    } else if (!allowUnauthenticated) {
      throw new Error(
        `Refusing to serve the MCP server over HTTP without authentication because anyone who can reach ${host}:${port} would be able to use every tool, including fetching arbitrary URLs from this machine. ` +
          `Pass \`--auth-token\` (or set the ${MCP_AUTH_TOKEN_ENV} environment variable) to require a bearer token, or \`--no-auth\` to serve it unauthenticated anyway.`,
      );
    } else {
      log.warning(
        `The MCP server is running over HTTP without authentication, so anyone who can reach ${host}:${port} can use every tool, including fetching arbitrary URLs from this machine.`,
      );
    }

    const transports = new Map<string, StreamableHTTPServerTransport>();
    const token = this.authToken ? Buffer.from(this.authToken) : null;
    const authorized = (req: IncomingMessage) => {
      if (!token) return true;
      const header = req.headers.authorization ?? "";
      const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
      return given.length === token.length && timingSafeEqual(given, token);
    };
    const reject = (res: ServerResponse, status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json", ...(status === 401 ? { "www-authenticate": "Bearer" } : {}) });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };

    const httpServer = createServer(async (req, res) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") return reject(res, 404, "Not found");
      if (!authorized(req)) return reject(res, 401, "Unauthorized");
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (sessionId) return reject(res, 404, "Session not found");
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
          enableDnsRebindingProtection: allowedHosts.length > 0,
          allowedHosts: allowedHosts.length ? allowedHosts : undefined,
          allowedOrigins: allowedHosts.length ? allowedHosts.flatMap((h) => [`http://${h}`, `https://${h}`]) : undefined,
        });
        transport.onclose = () => {
          if (transport!.sessionId) transports.delete(transport!.sessionId);
        };
        await this.buildServer().connect(transport);
      }
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
    log.info(`MCP server listening on http://${host}:${port}/mcp`);
  }
}
