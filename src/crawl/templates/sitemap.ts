import { parseXML, XMLSyntaxError } from "../../dom/xml.js";
import { Element } from "../../dom/nodes.js";
import type { Response } from "../../transport/utils/response.js";
import type { LinkExtractor } from "../links.js";
import { Request, type CallbackResult } from "../request.js";
import { RobotsTxt } from "../robotstxt.js";
import { Crawler } from "../crawler.js";
import type { CrawlRule } from "./link-crawler.js";
import { decompress } from "./utils.js";

/** A parsed sitemap: `urls` from a `<urlset>`, child `sitemaps` from a `<sitemapindex>` (fetched recursively) */
export interface SitemapResult {
  urls: string[];
  sitemaps: string[];
}

function childElements(element: Element): Element[] {
  return element.children;
}

/**
 * A crawler that seeds a crawl from sitemap(s) (or robots.txt files) and dispatches the URLs through `rules()`. Without
 * rules, all non-sitemap URLs go to `parse()`.
 */
export abstract class SitemapCrawler extends Crawler {
  /** Sitemap (or robots.txt) URLs to start from */
  sitemapUrls: string[] = [];
  /** Filters which child sitemaps of a `<sitemapindex>` to descend into, all of them when `null` */
  sitemapFollow: LinkExtractor | null = null;
  /** Route alternate-language URLs through `rules()` too */
  sitemapAlternateLinks = false;

  /** Override to define the dispatch rules for sitemap URLs */
  rules(): CrawlRule[] {
    return [];
  }

  override async *startRequests(): AsyncGenerator<Request> {
    if (!this.sitemapUrls.length) throw new Error("`SitemapCrawler` needs `sitemapUrls` to be set.");
    for (const url of this.sitemapUrls) yield new Request(url, { callback: this.parseSitemap });
  }

  parse(_response: Response): AsyncGenerator<CallbackResult> | Iterable<CallbackResult> | Promise<void> | void {
    throw new Error(`${this.constructor.name} must implement parse() method`);
  }

  /** `Sitemap` directives of a robots.txt body */
  protected robotsBody(response: Response): string[] {
    try {
      const text = new TextDecoder(response.encoding || "utf-8").decode(response.body);
      return RobotsTxt.parse(response.url, text).sitemaps;
    } catch (e) {
      this.logger.warning(`Failed to parse robots.txt: ${(e as Error).message}`);
      return [];
    }
  }

  protected extractUrls(root: Element): string[] {
    const urls: string[] = [];
    for (const urlElement of childElements(root)) {
      if (urlElement.localName !== "url") continue;
      for (const child of childElements(urlElement)) {
        if (child.localName === "loc" && child.textContent.trim()) urls.push(child.textContent.trim());
        else if (this.sitemapAlternateLinks && child.localName === "link") {
          const href = child.getAttribute("href");
          if (href) urls.push(href.trim());
        }
      }
    }
    return urls;
  }

  /** Parse a sitemap body and return its URLs and child sitemaps */
  sitemapBody(body: Uint8Array, contentType?: string | null): SitemapResult {
    let data: Uint8Array;
    try {
      data = decompress(body, contentType);
    } catch (e) {
      this.logger.warning(`Failed to decompress sitemap: ${(e as Error).message}`);
      return { urls: [], sitemaps: [] };
    }
    let root: Element;
    try {
      root = parseXML(new TextDecoder("utf-8").decode(data)).documentElement!;
    } catch (e) {
      if (!(e instanceof XMLSyntaxError)) throw e;
      this.logger.warning(`Failed to parse sitemap XML: ${e.message}`);
      return { urls: [], sitemaps: [] };
    }

    if (root.localName === "sitemapindex") {
      const sitemaps: string[] = [];
      for (const sitemap of childElements(root)) {
        if (sitemap.localName !== "sitemap") continue;
        const loc = childElements(sitemap).find((child) => child.localName === "loc" && child.textContent.trim());
        if (loc) sitemaps.push(loc.textContent.trim());
      }
      return { urls: [], sitemaps };
    }
    if (root.localName === "urlset") return { urls: this.extractUrls(root), sitemaps: [] };

    this.logger.warning(`Unknown sitemap root element: ${JSON.stringify(root.localName)}`);
    return { urls: [], sitemaps: [] };
  }

  async *parseSitemap(response: Response): AsyncGenerator<Request> {
    if (new URL(response.url).pathname.endsWith("/robots.txt")) {
      const sitemaps = this.robotsBody(response);
      if (!sitemaps.length) this.logger.warning(`No Sitemaps found in ${response.url}`);
      for (const url of sitemaps) yield response.follow(url, { callback: this.parseSitemap });
      return;
    }

    const result = this.sitemapBody(response.body, response.header("content-type"));
    // Descend into child sitemaps (filtered with `sitemapFollow` if set)
    for (const childUrl of result.sitemaps) {
      if (this.sitemapFollow && !this.sitemapFollow.matches(childUrl)) continue;
      yield response.follow(childUrl, { callback: this.parseSitemap });
    }
    // Dispatch each URL through the rules (first match wins; unmatched are dropped unless there are no rules)
    const rules = this.rules();
    for (const url of result.urls) {
      const request = this.dispatch(response, url, rules);
      if (request) yield request;
    }
  }

  protected dispatch(response: Response, url: string, rules: CrawlRule[]): Request | null {
    if (!rules.length) return response.follow(url, { callback: null });
    for (const rule of rules) {
      if (rule.linkExtractor.matches(url)) {
        let request = response.follow(url, { callback: rule.callback });
        if (rule.priority !== null) request.priority = rule.priority;
        if (rule.processRequest) request = rule.processRequest.call(this, request, response);
        return request;
      }
    }
    return null;
  }
}
