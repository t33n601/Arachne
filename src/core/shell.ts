/** The interactive scraping shell and the helpers of the `extract` commands */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import repl from "node:repl";
import { runInNewContext } from "node:vm";

import { ContentExtractor, type ExtractionType } from "./extract.js";
import { parseCurl, type CurlRequest } from "./curl.js";
import { levelFromName, LEVEL_NAMES, LogLevel, rootLogger } from "./logger.js";
import { Node, NodeList } from "../parser.js";
import { VERSION } from "../version.js";
import { Response } from "../transport/utils/response.js";
import {
  AsyncHttp,
  Browser,
  BrowserSession,
  Http,
  HttpSession,
  ProxyRotator,
  StealthBrowser,
  StealthBrowserSession,
} from "../clients/index.js";

/** Write the content of a page (or of the elements matching a CSS selector) to a `.md`, `.html`, or `.txt` file */
export function writeContentToFile(page: Node, filename: string, cssSelector?: string | null, mainContentOnly = false): void {
  if (!(page instanceof Node)) throw new TypeError("Input must be of type `Node`");
  if (!filename || !filename.trim()) throw new Error("Filename must be provided");
  const extension = filename.split(".").pop()!.toLowerCase();
  const type = ContentExtractor.extensionMap[extension] as ExtractionType | undefined;
  if (!type) throw new Error("Unknown file type: filename must end with '.md', '.html', or '.txt'");
  writeFileSync(filename, [...ContentExtractor.extractContent(page, type, cssSelector, mainContentOnly)].join(""), "utf-8");
}

/** Open a page's HTML in the default browser */
export function showPageInBrowser(page: Node): void {
  if (!(page instanceof Node)) {
    rootLogger.error("Input must be of type `Node`");
    return;
  }
  try {
    const file = join(mkdtempSync(join(tmpdir(), "arachne_view_")), "page.html");
    writeFileSync(file, page.htmlContent.valueOf(), "utf-8");
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [`file://${file}`], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    rootLogger.error(`Failed to open the page in a browser: ${(e as Error).message}`);
  }
}

/** Convert a curl command (or its parsed form) to a request and make it with `Http` */
export async function curlToRequest(command: string | CurlRequest): Promise<Response | null> {
  const request = typeof command === "string" ? parseCurl(command) : command;
  const { method, url, params, data, json, headers, cookies, proxies, followRedirects, verify } = request;
  const options = { params, headers, cookies, proxies: proxies ?? undefined, followRedirects, verify };
  switch (method) {
    case "get":
      return Http.get(url, options);
    case "delete":
      return Http.delete(url, options);
    case "post":
      return Http.post(url, { ...options, data: data as never, json });
    case "put":
      return Http.put(url, { ...options, data: data as never, json });
    default:
      rootLogger.error(`Request method "${method}" isn't supported yet`);
      return null;
  }
}

export function banner(): string {
  const pad = (text: string) => text.padEnd(30);
  return `
-> Available objects:
   - Http/AsyncHttp/HttpSession
   - Browser/BrowserSession
   - StealthBrowser/StealthBrowserSession
   - Node, ProxyRotator

-> Useful shortcuts (top-level await works):
   - ${pad("await get(url, options)")} Shortcut for \`Http.get\`
   - ${pad("await post(url, options)")} Shortcut for \`Http.post\`
   - ${pad("await put(url, options)")} Shortcut for \`Http.put\`
   - ${pad("await del(url, options)")} Shortcut for \`Http.delete\`
   - ${pad("await fetch(url, options)")} Shortcut for \`Browser.fetch\`
   - ${pad("await stealthFetch(url, options)")} Shortcut for \`StealthBrowser.fetch\`

-> Useful commands
   - ${pad("page / response")} The response object of the last page you fetched
   - ${pad("pages")} NodeList of the last 5 response objects you fetched
   - ${pad("uncurl('curl command')")} Convert a curl command (DevTools "Copy as cURL") to a request object
   - ${pad("await curl2request('curl command')")} Convert a curl command and make the request with Http
   - ${pad("view(page)")} View the page in a browser
   - ${pad("help()")} Show this help message

Type '.exit' or press Ctrl+D to exit.
`;
}

/** The interactive shell: a Node REPL preloaded with the clients, shortcuts, and the last fetched pages */
export class InteractiveShell {
  page: Node | null = null;
  readonly pages = new NodeList();
  private context: Record<string, unknown> | null = null;

  constructor(
    private readonly code = "",
    logLevel = "debug",
  ) {
    const level = levelFromName(logLevel);
    if (level === undefined) rootLogger.warning(`Unknown log level "${logLevel}", defaulting to "DEBUG"`);
    rootLogger.setLevel(level ?? LogLevel.DEBUG);
    const { storage: _storage, storageArgs: _storageArgs, ...settings } = Http.displayConfig();
    rootLogger.info(`Arachne ${VERSION} shell started`);
    rootLogger.info(`Logging level is set to '${LEVEL_NAMES[rootLogger.level]}'`);
    rootLogger.info(`Clients' parsing settings: ${JSON.stringify(settings)}`);
  }

  private updatePage<T>(result: T): T {
    if (result instanceof Node) {
      this.page = result;
      this.pages.push(result);
      if (this.pages.length > 5) this.pages.shift();
      if (this.context) {
        this.context.page = result;
        this.context.response = result;
      }
    }
    return result;
  }

  private wrap<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A) => this.updatePage(await fn(...args));
  }

  /** The objects available in the shell */
  namespace(): Record<string, unknown> {
    return {
      get: this.wrap((url: string, options?: Parameters<typeof Http.get>[1]) => Http.get(url, options)),
      post: this.wrap((url: string, options?: Parameters<typeof Http.post>[1]) => Http.post(url, options)),
      put: this.wrap((url: string, options?: Parameters<typeof Http.put>[1]) => Http.put(url, options)),
      del: this.wrap((url: string, options?: Parameters<typeof Http.delete>[1]) => Http.delete(url, options)),
      fetch: this.wrap((url: string, options?: Parameters<typeof Browser.fetch>[1]) => Browser.fetch(url, options)),
      stealthFetch: this.wrap((url: string, options?: Parameters<typeof StealthBrowser.fetch>[1]) => StealthBrowser.fetch(url, options)),
      curl2request: this.wrap(curlToRequest),
      uncurl: parseCurl,
      view: showPageInBrowser,
      help: () => console.log(banner()),
      Http,
      AsyncHttp,
      HttpSession,
      Browser,
      BrowserSession,
      StealthBrowser,
      StealthBrowserSession,
      ProxyRotator,
      Node,
      NodeList,
      page: this.page,
      response: this.page,
      pages: this.pages,
    };
  }

  /** Start the shell, or run the given code and exit */
  async start(): Promise<void> {
    if (this.code) {
      rootLogger.info(`Executing provided code: ${this.code}`);
      const context: Record<string, unknown> = { ...this.namespace(), console, process, URL };
      this.context = context;
      try {
        const result = await runInNewContext(`(async () => { ${this.code} })()`, context);
        if (result !== undefined) console.log(result);
      } catch (e) {
        rootLogger.error(`Error executing initial code: ${(e as Error).message}`);
      }
      return;
    }

    console.log(banner());
    const server = repl.start({ prompt: "arachne> ", useGlobal: false, breakEvalOnSigint: true });
    Object.assign(server.context, this.namespace());
    this.context = server.context;
    await new Promise<void>((resolve) => server.on("exit", () => resolve()));
    console.log("Bye Bye");
  }
}

export { parseCurl as uncurl };
