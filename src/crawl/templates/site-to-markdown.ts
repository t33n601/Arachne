import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Response } from "../../transport/utils/response.js";
import { LinkExtractor } from "../links.js";
import type { CallbackResult } from "../request.js";
import type { Item } from "../result.js";
import { CrawlRule, LinkCrawler } from "./link-crawler.js";

/**
 * Crawls a website and converts every page to clean, LLM-ready Markdown, for RAG/LLM ingestion pipelines.
 *
 * Yields one item per page with `url`, `title`, and `markdown` keys; with `outputDir` set, each page is also written to
 * a Markdown file named after its URL. Every page link inside `allowedDomains` (required) is followed; override `rules()`
 * to narrow the crawl.
 */
export class MarkdownCrawler extends LinkCrawler {
  /** Convert only the elements matching this CSS selector on each page */
  cssSelector: string | null = null;
  /** Convert only the content inside each page's `<body>` (default: true) */
  mainContentOnly = true;
  /** Write each page as a Markdown file in this directory */
  outputDir: string | null = null;
  /** Maximum number of pages to convert, `0` disables the cap */
  maxPages = 0;
  private pageCount = 0;
  private readonly usedNames = new Set<string>();

  protected override ensureInitialized(): void {
    if (![...this.allowedDomains].length) {
      throw new Error(`${this.constructor.name} must set \`allowedDomains\` to bound the crawl to the target website(s)`);
    }
    super.ensureInitialized();
  }

  /** Follow every page link, override to narrow the crawl */
  override rules(): CrawlRule[] {
    return [new CrawlRule(new LinkExtractor())];
  }

  override async *parse(response: Response): AsyncGenerator<CallbackResult> {
    if (this.maxPages && this.pageCount >= this.maxPages) return;
    this.pageCount++;
    yield {
      url: response.url,
      title: (response.css("title::text").get()?.toString() ?? "").trim(),
      markdown: response.markdown(this.cssSelector, this.mainContentOnly),
    };
    if (!this.maxPages || this.pageCount < this.maxPages) yield* super.parse(response);
  }

  override async onScrapedItem(item: Item): Promise<Item | null> {
    if (this.outputDir) {
      await mkdir(this.outputDir, { recursive: true });
      await writeFile(join(this.outputDir, `${this.filenameFor(String(item.url))}.md`), String(item.markdown), "utf-8");
    }
    return item;
  }

  /** A unique filesystem-safe name from the URL, suffixed with a hash on collisions */
  protected filenameFor(url: string): string {
    const parsed = new URL(url);
    let name =
      `${parsed.host}${parsed.pathname}`
        .replace(/^\/+|\/+$/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 150) || "index";
    if (this.usedNames.has(name)) name = `${name}-${createHash("sha1").update(url).digest("hex").slice(0, 8)}`;
    this.usedNames.add(name);
    return name;
  }
}
