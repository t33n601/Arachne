# Arachne

**Undetectable, tracking web scraping for Node.js and TypeScript.**

Arachne handles the whole scraping stack: it fetches pages like a real browser, parses them with CSS/XPath, survives website redesigns, and crawls whole sites with a production-ready crawler framework. It also ships with a CLI, an interactive shell, and an MCP server for AI agents.

```ts
import { Http } from "arachne-scraper";

const page = await Http.get("https://quotes.toscrape.com");
const quotes = page.css(".quote .text::text").getall();
```

## Features

- **Fast HTML parsing** — HTML5-compliant parsing (the same tree you see in DevTools), CSS selectors with `::text` / `::attr(name)`, XPath 1.0 with variables, search by text or regex, `findAll` filters, tree navigation, and selector generation.
- **Element tracking** — save an element once; when the website changes its layout, Arachne relocates it by similarity instead of breaking.
- **Similar elements** — give it one product card, get every other card on the page with `findSimilar()`.
- **Undetectable HTTP** — requests with the TLS/HTTP2 fingerprints of real Chrome/Firefox, real browser headers, cookie sessions, retries, proxy rotation, and SSRF-safe redirects.
- **Browsers** — Playwright-powered `Browser` for JavaScript-heavy pages, and `StealthBrowser` that passes common bot tests and solves Cloudflare Turnstile. Tab pooling, ad blocking, resource blocking, XHR capture.
- **Crawlers** — priority queue with deduplication, per-domain concurrency, delays, AutoThrottle, robots.txt, blocked-response retries, pause/resume with checkpoints, a development cache, streaming, and exports to JSON/JSONL/CSV/XML.
- **Crawler templates** — `LinkCrawler`, `SitemapCrawler`, `XmlFeedCrawler`, `CsvFeedCrawler`, `ShopifyCrawler`, `MarkdownCrawler`.
- **AI-ready** — clean Markdown extraction with prompt-injection sanitizing, and an MCP server for Claude, Cursor, and other agents.
- **TypeScript first** — full type definitions included.

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Parsing](#parsing)
- [Element tracking](#element-tracking)
- [Fetching](#fetching)
- [Browsers](#browsers)
- [Proxies](#proxies)
- [Crawlers](#crawlers)
- [Crawler templates](#crawler-templates)
- [CLI](#cli)
- [Interactive shell](#interactive-shell)
- [MCP server for AI agents](#mcp-server-for-ai-agents)
- [Using Arachne in your projects](#using-arachne-in-your-projects)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Installation

Requires **Node.js 22.5 or newer**.

```bash
npm install arachne-scraper
```

The HTTP client and the parser work right away. For the browser clients, download Chromium once:

```bash
npx arachne install
```

On Linux this also installs the system libraries Chromium needs.

## Quick start

```ts
import { Http, StealthBrowser } from "arachne-scraper";

// Plain HTTP with a real browser fingerprint
const page = await Http.get("https://quotes.toscrape.com");

for (const quote of page.css(".quote")) {
  console.log({
    text: quote.css(".text::text").get()?.toString(),
    author: quote.css(".author::text").get()?.toString(),
    tags: quote.css(".tag::text").getall().map(String),
  });
}

// A protected website? Use the stealth browser
const protectedPage = await StealthBrowser.fetch("https://example.com", { solveCloudflare: true });
console.log(protectedPage.markdown());
```

## Parsing

Every response is a `Node`. You can also parse HTML you already have:

```ts
import { Node } from "arachne-scraper";

const page = new Node(html, { url: "https://shop.example.com" });
```

### CSS and XPath

```ts
page.css("article.product");                       // NodeList (an array with extra methods)
page.css("h1::text").get();                        // first text or null
page.css("a::attr(href)").getall();                // all values
page.css(".price::text, .old-price::text");        // unions keep document order

page.xpath("//article[@data-id=$id]", { variables: { id: "42" } });
page.xpathValue("count(//article)");               // 12
```

Selecting from an element only searches inside it: `card.css("h3")` never escapes the card.

### Finding elements

```ts
page.find("div", { class: "product" });            // first match or null
page.findAll("div", { class: "product in-stock" }); // every class must be present
page.findAll(["h1", "h2"]);                        // any of these tags
page.findAll("span", /\$\d+/);                     // text matches the regex
page.findAll((el) => el.attrib.has("data-id"));    // custom filter
page.findAll({ "href*": "/products/" });           // attribute operators work too

page.findByText("Add to cart");                    // exact text, case-insensitive
page.findByText("stock", { partial: true, firstMatch: false });
page.findByRegex(/SKU-\d+/);
```

### Similar elements

```ts
const firstCard = page.css(".product").first!;
const allCards = firstCard.findSimilar(); // same depth, tag, parents, and similar attributes
```

### Navigation

```ts
const el = page.css(".price").first!;

el.parent;          el.children;       el.siblings;
el.next;            el.previous;       el.belowElements;
el.path;            // ancestors, closest first
el.findAncestor((a) => a.hasClass("product"));
```

### Text and attributes

```ts
el.tag;                                // "span"
el.text;                               // direct text of the element
el.getAllText({ strip: true });        // all nested text (scripts/styles ignored)
el.attrib.get("class");                // attribute or undefined
el.attr("href");                       // attribute, throws if missing
el.hasClass("price");
el.htmlContent;                        // outer HTML
el.prettify();                         // indented HTML

el.re(/[\d.]+/);                       // regex matches on the text
el.reFirst(/[\d.]+/);                  // first match or null
page.css("script#data::text").get()!.json(); // parse JSON
```

Text values are `TextValue` objects (a `String` subclass) with `.re()`, `.reFirst()`, `.clean()`, `.json()`, `.strip()`. Compare them with `==` or convert them with `.toString()`.

### Generating selectors

```ts
el.generateCssSelector;        // "#products > div > article:nth-of-type(2) > span"
el.generateXpathSelector;
el.generateFullCssSelector;
el.generateFullXpathSelector;
```

## Element tracking

Websites change their layouts and break your selectors. With tracking mode, Arachne remembers a fingerprint of the elements you select and finds them again after a redesign.

```ts
import { Http } from "arachne-scraper";

Http.configure({ track: true });

// First run: select and save
const page = await Http.get("https://shop.example.com");
page.css("#product-price", { saveTrack: true });

// Months later the id is gone and the structure changed, but this still finds it
const updated = await Http.get("https://shop.example.com");
updated.css("#product-price", { track: true });
```

- Use `identifier` to name what you save when the selector itself will change: `page.css(".price", { identifier: "price", saveTrack: true })`.
- `threshold` (default 40) sets the minimum similarity score accepted.
- Data is stored per website in SQLite at `~/.arachne/tracked_elements.db`. Change it with the `ARACHNE_STORAGE` environment variable, or plug your own storage through the `storage` option (a factory returning a `TrackStore`).

## Fetching

All methods are async. `Http` makes one-off requests; `HttpSession` keeps cookies and connections.

```ts
import { Http, HttpSession } from "arachne-scraper";

await Http.get(url, { params: { q: "shoes", page: 2 } });
await Http.post(url, { data: { login: "me", password: "..." } }); // form
await Http.post(url, { json: { query: "shoes" } });               // JSON
await Http.put(url, { data: "raw body" });
await Http.delete(url);

// A session: cookies set by the website are sent with the next requests
await using session = await new HttpSession({ impersonate: "chrome" }).start();
await session.post("https://example.com/login", { data: { user: "me", pass: "..." } });
const account = await session.get("https://example.com/account");
```

### Request options

| Option | Default | Description |
|---|---|---|
| `impersonate` | `"chrome"` | Browser fingerprint: `"chrome"`, `"firefox"`, `"edge"`, `"safari"`, a version like `"chrome142"`, a list to pick randomly, or `null` to disable |
| `stealthHeaders` | `true` | Add real browser headers and a Google referer |
| `headers` | — | Extra headers |
| `cookies` | — | Cookies for this request |
| `params` | — | Query string parameters |
| `data` / `json` | — | Request body |
| `auth` | — | Basic auth as `[user, password]` |
| `timeout` | `30` | Seconds |
| `retries` / `retryDelay` | `3` / `1` | Attempts on connection errors, seconds between them |
| `followRedirects` | `"safe"` | `"safe"` blocks redirects to internal/private IPs, `true` follows all, `false` none |
| `maxRedirects` | `30` | `-1` for unlimited |
| `proxy` / `proxies` / `proxyAuth` | — | See [Proxies](#proxies) |
| `verify` | `true` | Verify HTTPS certificates |
| `http3` | `false` | Use HTTP/3 |

### Responses

Every response is a `Node` with extra fields:

```ts
response.status;          // 200
response.reason;          // "OK"
response.url;             // final URL after redirects
response.headers;         // { "content-type": "text/html; charset=utf-8", ... }
response.header("Content-Type");
response.cookies;         // cookies set by the response
response.history;         // redirect responses
response.requestHeaders;
response.body;            // raw bytes (Uint8Array)
response.json();          // parsed JSON body
response.markdown();      // clean Markdown of the page
response.markdown("article", true); // only <article> elements, inside <body>
response.meta;            // your metadata (and the proxy used)
```

## Browsers

### Browser

A real Chromium browser for pages that need JavaScript.

```ts
import { Browser } from "arachne-scraper";

const page = await Browser.fetch("https://example.com", {
  networkIdle: true,             // wait for the network to be idle
  waitSelector: ".results",      // wait for an element
  disableResources: true,        // skip images, fonts, media, stylesheets
  blockAds: true,                // block ~3,500 ad/tracker domains
  pageAction: async (page) => {  // automate the Playwright page
    await page.click("#load-more");
    await page.waitForTimeout(1000);
  },
});
```

### StealthBrowser

A hardened browser that hides automation markers. Use it for protected websites.

```ts
import { StealthBrowser } from "arachne-scraper";

const page = await StealthBrowser.fetch("https://protected.example.com", {
  solveCloudflare: true,  // solves Turnstile and interstitial challenges
  hideCanvas: true,       // canvas fingerprint noise
  blockWebrtc: true,      // no local IP leaks through WebRTC
  headless: true,
});
```

### Browser sessions

Launching a browser is slow. For many pages, keep a session open; it reuses a pool of tabs.

```ts
import { StealthBrowserSession } from "arachne-scraper";

await using browser = await new StealthBrowserSession({ maxPages: 5, blockAds: true }).start();

const pages = await Promise.all(urls.map((url) => browser.fetch(url, { networkIdle: true })));
console.log(browser.getPoolStats()); // { totalPages, busyPages, maxPages }
```

`BrowserSession` works the same way. Without `await using`, call `await browser.close()` when you're done.

### Browser options

| Option | Default | Description |
|---|---|---|
| `headless` | `true` | Hide the browser window |
| `maxPages` | `1` | Tabs in the pool (sessions) |
| `timeout` | `30000` | Milliseconds for every operation |
| `wait` | `0` | Extra milliseconds to wait before returning |
| `networkIdle` | `false` | Wait for no network activity for 500 ms |
| `waitSelector` / `waitSelectorState` | — / `"attached"` | Wait for an element |
| `pageAction` / `pageSetup` | — | Functions that get the Playwright `page` after / before navigation |
| `disableResources` | `false` | Drop images, fonts, media, stylesheets |
| `blockAds` / `blockedDomains` | `false` / — | Block domains, subdomains included |
| `captureXhr` | — | Regex: matching XHR/fetch responses go to `response.capturedXhr` |
| `extraHeaders` / `useragent` / `locale` / `timezoneId` | — | Identity settings |
| `cookies` | — | Cookies in Playwright's format |
| `googleSearch` | `true` | Google referer |
| `realChrome` | `false` | Use your installed Chrome |
| `cdpUrl` | — | Connect to a running browser over CDP |
| `executablePath` | — | Custom Chromium-based browser |
| `userDataDir` | temp | Persistent profile directory |
| `proxy` / `proxyRotator` | — | See [Proxies](#proxies) |
| `dnsOverHttps` | `false` | Resolve DNS through Cloudflare DoH |
| `solveCloudflare`, `hideCanvas`, `blockWebrtc`, `allowWebgl` | | Stealth only |

## Proxies

```ts
import { Http, HttpSession, StealthBrowserSession, ProxyRotator } from "arachne-scraper";

// One proxy
await Http.get(url, { proxy: "http://user:pass@host:8080" });
await Http.get(url, { proxy: "socks5://host:1080" });

// Rotation (cyclic by default)
const rotator = new ProxyRotator([
  "http://user:pass@proxy1:8080",
  { server: "http://proxy2:8080", username: "user", password: "pass" },
]);
await using http = await new HttpSession({ proxyRotator: rotator }).start();
await using browser = await new StealthBrowserSession({ proxyRotator: rotator }).start();

// Your own strategy
const random = new ProxyRotator(list, (proxies) => [proxies[Math.floor(Math.random() * proxies.length)]!, 0]);
```

Failed requests are retried with the next proxy. The proxy used is in `response.meta.proxy`.

## Crawlers

A crawler crawls a website: it starts from some URLs, extracts items, and follows links.

```ts
import { Crawler, type Response } from "arachne-scraper/crawlers";

class QuotesCrawler extends Crawler {
  name = "quotes";
  startUrls = ["https://quotes.toscrape.com/"];
  concurrentRequests = 8;

  async *parse(response: Response) {
    for (const quote of response.css(".quote")) {
      yield {
        text: quote.css(".text::text").get()?.toString(),
        author: quote.css(".author::text").get()?.toString(),
      };
    }

    const next = response.css(".next a::attr(href)").get();
    if (next) yield response.follow(next.toString());
  }
}

const result = await new QuotesCrawler().start();
console.log(result.items.length, result.stats.toJSON());

result.items.toJson("quotes.json", { indent: true });
result.items.toJsonl("quotes.jsonl");
result.items.toCsv("quotes.csv");
result.items.toXml("quotes.xml");
```

`parse()` and other callbacks yield **items** (plain objects) and **requests**. They can also return an array or a single object.

### Following links and callbacks

```ts
async *parse(response: Response) {
  for (const href of response.css(".product a::attr(href)").getall()) {
    yield response.follow(href.toString(), { callback: this.parseProduct, meta: { category: "shoes" } });
  }
}

async *parseProduct(response: Response) {
  yield { name: response.css("h1::text").get()?.toString(), category: response.meta.category };
}
```

Callbacks always run with the crawler as `this`, so pass methods directly. `response.follow()` resolves relative URLs, sets the referer, and keeps the session options of the current request.

### Crawler settings

```ts
class MyCrawler extends Crawler {
  name = "my-crawler";
  startUrls = ["https://example.com"];
  allowedDomains = ["example.com"];        // requests elsewhere are dropped

  concurrentRequests = 8;
  concurrentRequestsPerDomain = 2;
  downloadDelay = 0.5;                     // seconds before each request
  robotsTxtObey = true;                    // also honors Crawl-delay and Request-rate

  autothrottleEnabled = true;              // adapts the delay to the server's latency
  maxBlockedRetries = 3;                   // 401/403/429/5xx are retried

  developmentMode = true;                  // cache responses on disk while you build the crawler
  loggingLevel = "info" as const;
  logFile = "logs/my-crawler.log";
}
```

### Hooks

```ts
class MyCrawler extends Crawler {
  async onStart(resuming: boolean) {}
  async onClose() {}
  async onError(request: Request, error: Error) {}
  async onScrapedItem(item: Item) { return item.price ? item : null; } // null drops the item
  async isBlocked(response: Response) { return response.status === 403 || response.css("#captcha").length > 0; }
  async retryBlockedRequest(request: Request, response: Response) { return request; }
  async *startRequests() { yield new Request("https://example.com", { headers: { "x-api": "1" } }); }
}
```

### Multiple sessions

Mix plain HTTP and browsers in one crawler:

```ts
import { HttpSession, StealthBrowserSession } from "arachne-scraper";
import { Crawler, Request, type SessionManager } from "arachne-scraper/crawlers";

class MixedCrawler extends Crawler {
  name = "mixed";
  startUrls = ["https://example.com"];

  configureSessions(manager: SessionManager) {
    manager.add("http", new HttpSession({ impersonate: "chrome" }));
    manager.add("browser", new StealthBrowserSession({ maxPages: 3 }), { lazy: true }); // started on first use
  }

  async *parse(response: Response) {
    yield new Request("https://example.com/js-page", { sid: "browser", callback: this.parseJs });
  }

  async *parseJs(response: Response) {
    yield { title: response.css("title::text").get()?.toString() };
  }
}
```

### Pause and resume

Pass a directory to enable checkpoints. Press **Ctrl+C** once to pause gracefully (twice to stop immediately); run the crawler again to continue where it stopped.

```ts
await new MyCrawler("./crawl-state").start();
```

You can also pause from code with `crawler.pause()`.

### Streaming

Process items as they arrive instead of waiting for the end:

```ts
const crawler = new MyCrawler();
for await (const item of crawler.stream()) {
  await db.insert(item);
  console.log(crawler.stats.requestsCount);
}
```

## Crawler templates

### LinkCrawler

Follows links automatically based on rules.

```ts
import { LinkCrawler, CrawlRule, LinkExtractor } from "arachne-scraper/crawlers";

class BlogCrawler extends LinkCrawler {
  name = "blog";
  startUrls = ["https://blog.example.com"];
  allowedDomains = ["blog.example.com"];

  rules() {
    return [
      new CrawlRule(new LinkExtractor({ allow: /\/page\/\d+/ })),                         // pagination, back to parse()
      new CrawlRule(new LinkExtractor({ allow: /\/posts\// }), { callback: this.parsePost }),
    ];
  }

  parsePost(response: Response) {
    return { title: response.css("h1::text").get()?.toString(), url: response.url };
  }
}
```

`LinkExtractor` options: `allow`, `deny`, `allowDomains`, `denyDomains`, `restrictCss`, `restrictXpath`, `tags`, `attrs`, `denyExtensions`, `canonicalize`, `process`.

### SitemapCrawler

Starts from sitemaps (or `robots.txt`), including sitemap indexes and gzipped sitemaps.

```ts
import { SitemapCrawler, CrawlRule, LinkExtractor } from "arachne-scraper/crawlers";

class ShopSitemap extends SitemapCrawler {
  name = "shop";
  sitemapUrls = ["https://shop.example.com/robots.txt"];

  rules() {
    return [new CrawlRule(new LinkExtractor({ allow: /\/products\// }), { callback: this.parseProduct })];
  }

  parseProduct(response: Response) {
    return { name: response.css("h1::text").get()?.toString() };
  }
}
```

### XmlFeedCrawler and CsvFeedCrawler

```ts
import { XmlFeedCrawler, CsvFeedCrawler } from "arachne-scraper/crawlers";
import type { Node } from "arachne-scraper";

class NewsFeed extends XmlFeedCrawler {
  name = "news";
  startUrls = ["https://example.com/rss.xml"];
  itertag = "item";

  parseNode(response: Response, node: Node) {
    return { title: node.css("title::text").get()?.toString(), link: node.css("link::text").get()?.toString() };
  }
}

class PriceList extends CsvFeedCrawler {
  name = "prices";
  startUrls = ["https://example.com/prices.csv"];

  parseRow(response: Response, row: Record<string, string>) {
    return row;
  }
}
```

### ShopifyCrawler

Extracts every product variant from any Shopify store through its JSON API.

```ts
import { ShopifyCrawler } from "arachne-scraper/crawlers";

class Store extends ShopifyCrawler {
  targetWebsite = "store.example.com";
}
const { items } = await new Store().start();
items.toCsv("products.csv");
```

### MarkdownCrawler

Converts a whole website to clean Markdown, ready for RAG/LLM pipelines.

```ts
import { MarkdownCrawler } from "arachne-scraper/crawlers";

class Docs extends MarkdownCrawler {
  name = "docs";
  startUrls = ["https://docs.example.com"];
  allowedDomains = ["docs.example.com"];
  outputDir = "./docs-md";   // one .md file per page
  maxPages = 500;
}
await new Docs().start();
```

## CLI

```bash
# Save a page as Markdown, HTML, or text (by the file extension)
arachne extract get https://example.com page.md
arachne extract get https://example.com page.txt -s "article"          # only matching elements
arachne extract get https://example.com page.md --ai-targeted          # main content, sanitized
arachne extract post https://example.com/api out.html -j '{"q":"shoes"}'

# With browsers
arachne extract browser https://example.com page.md --network-idle
arachne extract stealth https://example.com page.md --solve-cloudflare --block-ads

# Other commands
arachne install     # download Chromium
arachne shell       # interactive shell
arachne mcp         # MCP server

arachne --help
arachne extract get --help
```

## Interactive shell

```bash
arachne shell
```

A Node REPL with everything preloaded and top-level `await`:

```js
arachne> await get("https://quotes.toscrape.com")
arachne> page.css(".author::text").getall()
arachne> await stealthFetch("https://example.com", { solveCloudflare: true })
arachne> pages                      // the last 5 responses
arachne> view(page)                 // open the page in your browser
arachne> uncurl(`curl 'https://api.example.com' -H 'accept: application/json'`)
arachne> await curl2request(`curl ...`)   // paste "Copy as cURL" from DevTools and run it
```

Run code without the prompt: `arachne shell -c 'const p = await get("https://example.com"); return p.status'`.

## MCP server for AI agents

The MCP server gives AI agents tools to fetch pages as clean Markdown, with sessions, bulk requests, stealth browsing, and screenshots.

**Claude Code:**

```bash
claude mcp add arachne -- npx -y arachne-scraper mcp
```

**Claude Desktop / Cursor / other clients** (`mcpServers` config):

```json
{
  "mcpServers": {
    "arachne": {
      "command": "npx",
      "args": ["-y", "arachne-scraper", "mcp"]
    }
  }
}
```

**Over HTTP** (requires a bearer token):

```bash
ARACHNE_MCP_AUTH_TOKEN=secret arachne mcp --http --host 0.0.0.0 --port 8000 --allowed-host my.server.com
```

Tools: `http_request`, `bulk_http_request`, `browser_fetch`, `bulk_browser_fetch`, `stealth_fetch`, `bulk_stealth_fetch`, `open_session`, `open_http_session`, `session_browser_fetch`, `session_http_request`, `list_sessions`, `close_session`, `screenshot`.

You can also embed it:

```ts
import { ScrapingMCPServer } from "arachne-scraper/mcp";
await new ScrapingMCPServer().serve(); // stdio
```

## Using Arachne in your projects

Arachne runs on the **server side** (Node.js), not in the browser.

### Express API

```ts
import express from "express";
import { Http } from "arachne-scraper";

const app = express();

app.get("/api/quotes", async (_req, res) => {
  const page = await Http.get("https://quotes.toscrape.com");
  res.json(
    page.css(".quote").map((q) => ({
      text: q.css(".text::text").get()?.toString(),
      author: q.css(".author::text").get()?.toString(),
    })),
  );
});

app.listen(3000);
```

### Next.js

Use it in route handlers, server components, or server actions:

```ts
// app/api/scrape/route.ts
import { Http } from "arachne-scraper";

export async function GET() {
  const page = await Http.get("https://quotes.toscrape.com");
  return Response.json({ title: page.css("title::text").get()?.toString() });
}
```

Add the native dependencies to `next.config.js`:

```js
module.exports = {
  serverExternalPackages: ["arachne-scraper", "impit", "playwright", "patchright"],
};
```

### Long-running servers with browsers

Start one browser session at boot and reuse it for every request:

```ts
import { StealthBrowserSession } from "arachne-scraper";

const browser = await new StealthBrowserSession({ maxPages: 4, blockAds: true }).start();

app.get("/api/render", async (req, res) => {
  const page = await browser.fetch(String(req.query.url));
  res.send(page.markdown());
});

process.on("SIGTERM", () => browser.close());
```

### CommonJS projects

Arachne is an ES module. In CommonJS, load it with a dynamic import:

```js
const { Http } = await import("arachne-scraper");
```

### Hosting

The HTTP client and the parser run anywhere Node.js runs, including serverless functions. Browser clients need Chromium, so use a VPS, a container, or any host that can run a full browser (serverless platforms usually exceed their size limits).

## Configuration

### Parser settings for clients

```ts
import { Http, StealthBrowser } from "arachne-scraper";

Http.configure({ track: true, keepComments: false });
StealthBrowser.configure({ track: true, trackDomain: "example.com" });

// Or per request
await Http.get(url, { selectorConfig: { track: true } });
```

### Logging

```ts
import { rootLogger } from "arachne-scraper";

rootLogger.setLevel("warning"); // "debug" | "info" | "warning" | "error" | "critical"
```

Crawlers have their own logger: set `loggingLevel`, `loggingFormat`, and `logFile` on the crawler, and use `this.logger` inside it.

### Environment variables

| Variable | Description |
|---|---|
| `ARACHNE_STORAGE` | Path of the tracking storage database (default `~/.arachne/tracked_elements.db`) |
| `ARACHNE_EXECUTABLE_PATH` | Default browser executable for the CLI and the MCP server |
| `ARACHNE_MCP_AUTH_TOKEN` | Bearer token of the MCP HTTP transport |

## Troubleshooting

**`Executable doesn't exist` when using browsers** — run `npx arachne install`.

**`Refusing to follow a redirect to an internal address`** — the default `followRedirects: "safe"` blocks redirects to private IPs (SSRF protection). Pass `followRedirects: true` if you trust the target.

**Connection refused to `127.0.0.1` for a public domain** — your system resolves that domain locally (check `/etc/hosts`, VPN, or DNS filters).

**`ExperimentalWarning: SQLite is an experimental feature`** — printed by Node.js the first time tracking mode is used. It's harmless; hide it with `NODE_OPTIONS=--disable-warning=ExperimentalWarning`.

**Still blocked by a website** — move up the ladder: `Http` → `Http` with `impersonate: "firefox"` and a residential proxy → `StealthBrowser` → `StealthBrowser` with `solveCloudflare: true` and `realChrome: true`.

## Development

```bash
git clone <repository-url>
cd arachne
npm install
npx arachne install   # Chromium for the browser tests
npm test
npm run build
```

## License

BSD-3-Clause, see [LICENSE](LICENSE).
