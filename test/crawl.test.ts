import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpSession } from "../src/transport/http.js";
import type { Response } from "../src/transport/utils/response.js";
import type { Node } from "../src/parser.js";
import {
  CrawlRule,
  LinkCrawler,
  CsvFeedCrawler,
  LinkExtractor,
  Request,
  ShopifyCrawler,
  SitemapCrawler,
  MarkdownCrawler,
  Crawler,
  XmlFeedCrawler,
  canonicalizeUrl,
  type SessionManager,
} from "../src/crawl/index.js";
import { html, json, startServer, type TestServer } from "./helpers/server.js";

let server: TestServer;
let tmp: string;

const productPage = (i: number) =>
  `<html><head><title>Product ${i}</title></head><body><h1>Product ${i}</h1><span class="price">$${i}.99</span>
   <a href="/products/${(i % 5) + 1}">next</a><a href="/products/${i}#reviews">self</a><a href="https://other.example/x">offsite</a>
   <img src="/img.png"><a href="/file.pdf">pdf</a></body></html>`;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "arachne-crawlers-"));
  const routes: Parameters<typeof startServer>[0] = {
    "/": (_req, res) =>
      html(res, `<html><body><ul>${[1, 2, 3].map((i) => `<li><a href="/products/${i}">p${i}</a></li>`).join("")}</ul></body></html>`),
    "/blocked": (_req, res) => html(res, "blocked", 503, { "retry-after": "0" }),
    "/robots.txt": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private\nCrawl-delay: 0\nSitemap: /sitemap.xml\n");
    },
    "/private": (_req, res) => html(res, "<p>secret</p>"),
    "/sitemap.xml": (_req, res) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>${server.url}/posts-sitemap.xml.gz</loc></sitemap></sitemapindex>`);
    },
    "/posts-sitemap.xml.gz": (_req, res) => {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(
        gzipSync(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${server.url}/products/1</loc></url><url><loc>${server.url}/about</loc></url></urlset>`),
      );
    },
    "/about": (_req, res) => html(res, "<title>About</title>"),
    "/feed.xml": (_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(`<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel>
        <item><title>First</title><link>${server.url}/a</link><media:content url="m1"/></item>
        <item><title><![CDATA[Second & more]]></title><link>${server.url}/b</link></item></channel></rss>`);
    },
    "/feed.csv": (_req, res) => {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end('name,price\n"Widget, big",10\nGadget,20\n');
    },
    "/collections.json": (req, res) => {
      const page = new URL(req.url!, "http://x").searchParams.get("page");
      json(res, { collections: page === "1" ? [{ handle: "summer-sale", products_count: 1 }, { handle: "empty", products_count: 0 }] : [] });
    },
    "/collections/summer-sale/products.json": (req, res) => {
      const page = new URL(req.url!, "http://x").searchParams.get("page");
      json(res, {
        products:
          page === "1"
            ? [
                {
                  title: "Shirt",
                  handle: "shirt",
                  vendor: "Acme",
                  body_html: "<p>Nice <b>shirt</b></p>",
                  images: [{ src: "https://cdn/shirt.png" }],
                  variants: [
                    { id: 1, title: "Default Title", price: "10.00", sku: "S1", available: true, compare_at_price: "12.00" },
                    { id: 2, title: "XL", price: "11.00", available: false, compare_at_price: "0.00" },
                  ],
                },
              ]
            : [],
      });
    },
  };
  for (let i = 1; i <= 5; i++) routes[`/products/${i}`] = (_req, res) => html(res, productPage(i));
  server = await startServer(routes);
});

afterAll(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

class QuietSession {
  static http(): HttpSession {
    return new HttpSession({ impersonate: null, retries: 1 });
  }
}

abstract class TestCrawler extends Crawler {
  override loggingLevel = 40;
  override configureSessions(manager: SessionManager): void {
    manager.add("default", QuietSession.http());
  }
}

describe("Crawler", () => {
  it("crawls, follows links, dedupes, and filters offsite requests", async () => {
    class Products extends TestCrawler {
      override name = "products";
      override startUrls = [`${server.url}/`];
      override allowedDomains = ["127.0.0.1"];

      async *parse(response: Response) {
        for (const href of response.css("li a::attr(href)")) yield response.follow(href.text.valueOf(), { callback: this.parseProduct });
      }

      async *parseProduct(response: Response) {
        yield { name: response.css("h1::text").get()?.toString(), price: response.css(".price::text").get()?.toString() };
        for (const href of response.css("a::attr(href)")) yield response.follow(href.text.valueOf());
      }
    }
    const result = await new Products().start();
    const names = result.items.map((item) => item.name).filter(Boolean).sort();
    expect(names).toEqual(["Product 1", "Product 2", "Product 3", "Product 4", "Product 5"]);
    expect(result.completed).toBe(true);
    expect(result.stats.offsiteRequestsCount).toBeGreaterThan(0);
    expect(result.stats.requestsCount).toBe(6 + 1); // home + 5 products + the /file.pdf 404
    expect(result.stats.responseStatusCount.status_200).toBe(6);
  });

  it("requires a name and sessions", async () => {
    class NoName extends Crawler {
      parse() {}
    }
    await expect(new NoName().start()).rejects.toThrow(/must have a name/);
    class NoSessions extends Crawler {
      override name = "x";
      override configureSessions() {}
      parse() {}
    }
    await expect(new NoSessions().start()).rejects.toThrow(/did not add any sessions/);
  });

  it("retries blocked responses and records autothrottle delays", async () => {
    class Blocked extends TestCrawler {
      override name = "blocked";
      override startUrls = [`${server.url}/blocked`];
      override maxBlockedRetries = 2;
      override autothrottleEnabled = true;
      override autothrottleStartDelay = 0;
      override autothrottleMaxDelay = 0.05;
      parse() {
        return { reached: true };
      }
    }
    const result = await new Blocked().start();
    expect(result.items).toHaveLength(0);
    expect(result.stats.blockedRequestsCount).toBe(3);
    expect(Object.keys(result.stats.autothrottleDelays)).toHaveLength(1);
  });

  it("obeys robots.txt", async () => {
    class Robots extends TestCrawler {
      override name = "robots";
      override robotsTxtObey = true;
      override startUrls = [`${server.url}/private`, `${server.url}/about`];
      parse(response: Response) {
        return { url: response.url };
      }
    }
    const result = await new Robots().start();
    expect(result.items.map((item) => item.url)).toEqual([`${server.url}/about`]);
    expect(result.stats.robotsDisallowedCount).toBe(1);
  });

  it("supports plain return values, on_scraped_item drops, errors, and streaming", async () => {
    const errors: string[] = [];
    class Mixed extends TestCrawler {
      override name = "mixed";
      override startUrls = [`${server.url}/products/1`, `${server.url}/products/2`, `${server.url}/products/3`];
      parse(response: Response) {
        if (response.url.endsWith("/3")) throw new Error("boom");
        return [{ url: response.url, keep: response.url.endsWith("/1") }];
      }
      override async onScrapedItem(item: Record<string, unknown>) {
        return item.keep ? item : null;
      }
      override async onError(_request: Request, error: Error) {
        errors.push(error.message);
      }
    }
    const crawler = new Mixed();
    const streamed = [];
    for await (const item of crawler.stream()) {
      streamed.push(item);
      expect(crawler.stats.requestsCount).toBeGreaterThan(0);
    }
    expect(streamed).toEqual([{ url: `${server.url}/products/1`, keep: true }]);
    expect(errors).toEqual(["boom"]);
  });

  it("caches responses in development mode", async () => {
    const cacheDir = join(tmp, "cache");
    class Dev extends TestCrawler {
      override name = "dev";
      override developmentMode = true;
      override developmentCacheDir = cacheDir;
      override startUrls = [`${server.url}/about`];
      parse(response: Response) {
        return { title: response.css("title::text").get()?.toString(), meta: response.meta.tag ?? null };
      }
    }
    const first = await new Dev().start();
    const second = await new Dev().start();
    expect(first.stats.cacheMisses).toBe(1);
    expect(second.stats.cacheHits).toBe(1);
    expect(second.items).toEqual(first.items);
    expect(readdirSync(cacheDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("pauses with a checkpoint and resumes from it", async () => {
    const crawldir = join(tmp, "crawl");
    class Pausing extends TestCrawler {
      override name = "pausing";
      override concurrentRequests = 1;
      override startUrls = [1, 2, 3, 4, 5].map((i) => `${server.url}/products/${i}`);
      async *parse(response: Response) {
        if (response.url.endsWith("/1")) this.pause();
        yield { url: response.url };
      }
    }
    const first = await new Pausing(crawldir).start();
    expect(first.paused).toBe(true);
    expect(JSON.parse(readFileSync(join(crawldir, "checkpoint.json"), "utf-8")).requests.length).toBeGreaterThan(0);
    const second = await new Pausing(crawldir).start();
    expect(second.completed).toBe(true);
    const all = [...first.items, ...second.items].map((item) => item.url);
    expect(new Set(all).size).toBe(5);
  });

  it("exports items", async () => {
    class Export extends TestCrawler {
      override name = "export";
      override startUrls = [`${server.url}/about`];
      parse() {
        return { "title": "About", "bad key": [1, 2], "quote": 'a "b", c' };
      }
    }
    const { items } = await new Export().start();
    items.toJson(join(tmp, "out/items.json"));
    items.toJsonl(join(tmp, "out/items.jsonl"));
    items.toCsv(join(tmp, "out/items.csv"));
    items.toXml(join(tmp, "out/items.xml"));
    expect(JSON.parse(readFileSync(join(tmp, "out/items.json"), "utf-8"))).toEqual([{ "title": "About", "bad key": [1, 2], "quote": 'a "b", c' }]);
    expect(readFileSync(join(tmp, "out/items.csv"), "utf-8")).toBe('title,bad key,quote\r\nAbout,"[1,2]","a ""b"", c"\r\n');
    expect(readFileSync(join(tmp, "out/items.xml"), "utf-8")).toContain('<bad_key name="bad key">[1,2]</bad_key>');
  });
});

describe("Request", () => {
  it("fingerprints canonical URLs and dedupes", () => {
    const a = new Request("https://Example.com/p?b=2&a=1#frag");
    const b = new Request("https://example.com/p?a=1&b=2");
    expect(a.updateFingerprint()).toBe(b.updateFingerprint());
    expect(new Request("https://example.com/p", { method: "POST", data: { x: "1" } }).updateFingerprint()).not.toBe(
      new Request("https://example.com/p", { method: "POST", data: { x: "2" } }).updateFingerprint(),
    );
    expect(canonicalizeUrl("https://example.com/a%7eb?z=1&a=hello world")).toBe("https://example.com/a~b?a=hello+world&z=1");
  });

  it("serializes for checkpoints", () => {
    class S {
      parseItem() {}
    }
    const crawler = new S();
    const request = new Request("https://example.com", { callback: crawler.parseItem, priority: 3, headers: { a: "1" } });
    request.updateFingerprint();
    const restored = Request.fromJSON(JSON.parse(JSON.stringify(request.toJSON())));
    restored.restoreCallback(crawler);
    expect(restored.callback).toBe(crawler.parseItem);
    expect(restored.priority).toBe(3);
    expect(restored.sessionKwargs).toEqual({ headers: { a: "1" } });
    expect(restored._fp).toBe(request._fp);
  });
});

describe("LinkExtractor", () => {
  it("extracts and filters links", async () => {
    const response = await QuietSession.http()
      .start()
      .then((session) => session.get(`${server.url}/products/1`));
    const links = new LinkExtractor().extract(response);
    expect(links).toEqual([`${server.url}/products/2`, `${server.url}/products/1`, "https://other.example/x"]);
    expect(new LinkExtractor({ allowDomains: "127.0.0.1" }).extract(response)).toHaveLength(2);
    expect(new LinkExtractor({ deny: /products\/1/ }).extract(response)).toHaveLength(2);
    expect(new LinkExtractor({ keepFragment: true, canonicalize: true }).extract(response)).toContain(`${server.url}/products/1#reviews`);
    expect(new LinkExtractor({ tags: ["img"], attrs: ["src"], denyExtensions: [] }).extract(response)).toEqual([`${server.url}/img.png`]);
    expect(new LinkExtractor().matches("https://x.com/file.tar.gz")).toBe(false);
  });
});

describe("templates", () => {
  it("LinkCrawler follows rules", async () => {
    class RuleCrawler extends LinkCrawler {
      override name = "crawler";
      override loggingLevel = 40;
      override startUrls = [`${server.url}/`];
      override allowedDomains = ["127.0.0.1"];
      override configureSessions(manager: SessionManager) {
        manager.add("default", QuietSession.http());
      }
      override rules() {
        return [new CrawlRule(new LinkExtractor({ allow: /\/products\/\d+$/ }), { callback: this.parseProduct })];
      }
      parseProduct(response: Response) {
        return { title: response.css("title::text").get()?.toString() };
      }
    }
    const result = await new RuleCrawler().start();
    expect(result.items.map((item) => item.title).sort()).toEqual(["Product 1", "Product 2", "Product 3"]);
  });

  it("SitemapCrawler walks robots.txt, indexes, and gzipped sitemaps", async () => {
    const seen: string[] = [];
    class Sitemaps extends SitemapCrawler {
      override name = "sitemaps";
      override loggingLevel = 40;
      override sitemapUrls = [`${server.url}/robots.txt`];
      override configureSessions(manager: SessionManager) {
        manager.add("default", QuietSession.http());
      }
      override parse(response: Response) {
        seen.push(response.url);
      }
    }
    await new Sitemaps().start();
    expect(seen.sort()).toEqual([`${server.url}/about`, `${server.url}/products/1`]);
  });

  it("XmlFeedCrawler and CsvFeedCrawler iterate feeds", async () => {
    class Feed extends XmlFeedCrawler {
      override name = "feed";
      override loggingLevel = 40;
      override startUrls = [`${server.url}/feed.xml`];
      override configureSessions(manager: SessionManager) {
        manager.add("default", QuietSession.http());
      }
      parseNode(_response: Response, node: Node): Record<string, unknown> {
        return { title: node.css("title::text").get()?.toString(), link: node.xpath("./link/text()").get()?.toString(), media: node.css("content::attr(url)").get()?.toString() ?? null };
      }
    }
    const feed = await new Feed().start();
    expect(feed.items).toEqual([
      { title: "First", link: `${server.url}/a`, media: "m1" },
      { title: "Second & more", link: `${server.url}/b`, media: null },
    ]);

    class Media extends Feed {
      override itertag = "media:content";
      override namespaces: [string, string][] = [["media", "http://search.yahoo.com/mrss/"]];
      override parseNode(_response: Response, node: Node) {
        return { url: node.attr("url").valueOf() };
      }
    }
    expect((await new Media().start()).items).toEqual([{ url: "m1" }]);

    class Csv extends CsvFeedCrawler {
      override name = "csv";
      override loggingLevel = 40;
      override startUrls = [`${server.url}/feed.csv`];
      override configureSessions(manager: SessionManager) {
        manager.add("default", QuietSession.http());
      }
      parseRow(_response: Response, row: Record<string, string>) {
        return row;
      }
    }
    expect((await new Csv().start()).items).toEqual([
      { name: "Widget, big", price: "10" },
      { name: "Gadget", price: "20" },
    ]);
  });

  it("ShopifyCrawler extracts every variant", async () => {
    class Shop extends ShopifyCrawler {
      override loggingLevel = 40;
      override configureSessions(manager: SessionManager) {
        manager.add("default", QuietSession.http());
      }
    }
    const crawler = new Shop();
    crawler.targetWebsite = server.url.replace("http://", "");
    crawler.collectionsUrl = "http://{website}/collections.json?page={page}&limit=250";
    crawler.productsUrl = "http://{website}/collections/{handle}/products.json?page={page}&limit=250";
    const result = await crawler.start();
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ name: "Shirt", price: "10.00", category: "Summer Sale", description: "Nice shirt", old_price: "12.00", stock: null });
    expect(result.items[1]).toMatchObject({ name: "Shirt - XL", stock: 0, old_price: "" });
  });

  it("MarkdownCrawler converts pages and writes files", async () => {
    const outputDir = join(tmp, "md");
    class Docs extends MarkdownCrawler {
      override name = "docs";
      override loggingLevel = 40;
      override startUrls = [`${server.url}/products/1`];
      override allowedDomains = ["127.0.0.1"];
      override outputDir = outputDir;
      override maxPages = 2;
      override configureSessions(manager: SessionManager) {
        manager.add("default", QuietSession.http());
      }
    }
    const result = await new Docs().start();
    expect(result.items).toHaveLength(2);
    expect(String(result.items[0]!.markdown)).toContain("# Product 1");
    expect(readdirSync(outputDir)).toHaveLength(2);

    class NoDomains extends MarkdownCrawler {
      override name = "x";
    }
    await expect(new NoDomains().start()).rejects.toThrow(/allowedDomains/);
  });
});
