import { consoleHandler, fileHandler, Logger, LogLevel, makeFormatter, withLogger, type LogLevelName } from "../core/logger.js";
import { HttpSession } from "../transport/http.js";
import type { Response } from "../transport/utils/response.js";
import { CrawlerEngine } from "./engine.js";
import { Request, type CallbackResult } from "./request.js";
import { CrawlResult, type CrawlStats, type Item } from "./result.js";
import { SessionManager } from "./session.js";

export const BLOCKED_CODES = new Set([401, 403, 407, 429, 444, 500, 502, 503, 504]);

/** Raised when `configureSessions()` fails */
export class SessionConfigurationError extends Error {
  override name = "SessionConfigurationError";
}

type ParseOutput =
  | AsyncIterable<CallbackResult>
  | Iterable<CallbackResult>
  | Promise<CallbackResult | Iterable<CallbackResult> | void>
  | CallbackResult
  | void;

/**
 * The base class of crawlers. Subclass it, set `name` and `startUrls`, and implement `parse()`, usually as an async
 * generator yielding items (plain objects) and follow-up `Request`s:
 *
 * ```ts
 * class QuotesCrawler extends Crawler {
 *   name = "quotes";
 *   startUrls = ["https://quotes.toscrape.com/"];
 *
 *   async *parse(response: Response) {
 *     for (const quote of response.css(".quote")) {
 *       yield { text: quote.css(".text::text").get()?.toString(), author: quote.css(".author::text").get()?.toString() };
 *     }
 *     const next = response.css(".next a::attr(href)").get();
 *     if (next) yield response.follow(next.toString());
 *   }
 * }
 *
 * const result = await new QuotesCrawler().start();
 * result.items.toJson("quotes.json");
 * ```
 */
export abstract class Crawler {
  /** The crawler name, required */
  name: string | null = null;
  startUrls: string[] = [];
  allowedDomains: Iterable<string> = [];

  /** Respect the robots.txt rules (and their Crawl-delay/Request-rate directives) */
  robotsTxtObey = false;

  /** Cache responses to disk and replay them on later runs, handy while developing a crawler */
  developmentMode = false;
  developmentCacheDir: string | null = null;

  concurrentRequests = 4;
  /** `0` means only the global limit applies */
  concurrentRequestsPerDomain = 0;
  /** Seconds to wait before each request */
  downloadDelay = 0.0;
  maxBlockedRetries = 3;

  autothrottleEnabled = false;
  autothrottleStartDelay = 5.0;
  autothrottleMaxDelay = 60.0;
  autothrottleTargetConcurrency: number | null = null;
  autothrottleBlockBackoff = true;

  // Fingerprint adjustments
  fpIncludeKwargs = false;
  fpKeepFragments = false;
  fpIncludeHeaders = false;

  loggingLevel: number | LogLevelName = LogLevel.DEBUG;
  loggingFormat = "[{time}]:({spider_name}) {level}: {message}";
  logFile: string | null = null;

  readonly crawldir: string | null;
  private readonly interval: number;
  private engine: CrawlerEngine | null = null;
  private initialized = false;
  private loggerInstance: Logger | null = null;
  private readonly logCounter: Record<string, number> = { debug: 0, info: 0, warning: 0, error: 0, critical: 0 };
  private sessionManagerInstance: SessionManager | null = null;

  /**
   * @param crawldir Directory for checkpoint files, enables pause/resume when set
   * @param interval Seconds between periodic checkpoint saves (default 5 minutes)
   */
  constructor(crawldir: string | null = null, interval = 300.0) {
    this.crawldir = crawldir;
    this.interval = interval;
  }

  /** The crawler's logger (created on first use) */
  get logger(): Logger {
    if (!this.loggerInstance) {
      const format = makeFormatter(this.loggingFormat.replace("{spider_name}", this.name ?? this.constructor.name));
      const logger = new Logger(`arachne.crawlers.${this.name ?? this.constructor.name}`, LogLevel.DEBUG, []);
      logger.setLevel(this.loggingLevel);
      // Count log messages by level for the final stats
      logger.addHandler((record) => {
        const level =
          record.level >= LogLevel.CRITICAL
            ? "critical"
            : record.level >= LogLevel.ERROR
              ? "error"
              : record.level >= LogLevel.WARNING
                ? "warning"
                : record.level >= LogLevel.INFO
                  ? "info"
                  : "debug";
        this.logCounter[level]!++;
      });
      logger.addHandler(consoleHandler(format));
      if (this.logFile) logger.addHandler(fileHandler(this.logFile, format));
      this.loggerInstance = logger;
    }
    return this.loggerInstance;
  }

  /** @internal Counts of the logged messages by level */
  logCounts(): Record<string, number> {
    return { ...this.logCounter };
  }

  /** The session manager, configured on first use through `configureSessions()` */
  get sessionManager(): SessionManager {
    this.ensureInitialized();
    return this.sessionManagerInstance!;
  }

  /**
   * Subclass fields are only set after the base constructor runs in JavaScript, so the crawler's configuration is
   * validated lazily, right before it's first needed.
   */
  protected ensureInitialized(): void {
    if (this.initialized) return;
    if (!this.name) throw new Error(`${this.constructor.name} must have a name.`);
    const manager = new SessionManager();
    try {
      this.configureSessions(manager);
    } catch (e) {
      throw new SessionConfigurationError(`Error in ${this.constructor.name}.configureSessions(): ${(e as Error).message}`);
    }
    if (manager.size === 0) throw new SessionConfigurationError(`${this.constructor.name}.configureSessions() did not add any sessions`);
    this.sessionManagerInstance = manager;
    this.initialized = true;
    this.logger.info("Crawler initialized");
  }

  /**
   * Generate the initial requests. By default it yields a request per URL in `startUrls` with the default session and
   * `parse()` as callback. Override it for more control (custom headers, other callbacks...).
   */
  async *startRequests(): AsyncGenerator<Request> {
    if (!this.startUrls.length) {
      throw new Error("Crawler has no starting point, either set `startUrls` or override `startRequests()`.");
    }
    for (const url of this.startUrls) yield new Request(url, { sid: this.sessionManager.defaultSessionId });
  }

  /** The default callback for processing responses */
  abstract parse(response: Response): ParseOutput;

  /** Called before crawling starts */
  async onStart(resuming = false): Promise<void> {
    if (resuming) this.logger.debug("Resuming crawler from checkpoint");
    else this.logger.debug("Starting crawler");
  }

  /** Called after crawling finishes */
  async onClose(): Promise<void> {
    this.logger.debug("Crawler closed");
  }

  /** Handle request errors, override for custom handling */
  async onError(_request: Request, _error: Error): Promise<void> {}

  /** Process scraped items, return `null` to drop the item silently */
  async onScrapedItem(item: Item): Promise<Item | null> {
    return item;
  }

  /** Detect blocked responses, override for custom detection logic */
  async isBlocked(response: Response): Promise<boolean> {
    return BLOCKED_CODES.has(response.status);
  }

  /** Prepare a blocked request before it's retried, if needed */
  async retryBlockedRequest(request: Request, _response: Response): Promise<Request> {
    return request;
  }

  /**
   * Configure the sessions of this crawler. The default creates a `HttpSession`; the first added session becomes the
   * default one unless specified otherwise.
   */
  configureSessions(manager: SessionManager): void {
    manager.add("default", new HttpSession());
  }

  /** Request a graceful pause of the crawl */
  pause(): void {
    if (!this.engine) throw new Error("No active crawl to stop");
    this.engine.requestPause();
  }

  toString(): string {
    return `<${this.constructor.name} '${this.name}'>`;
  }

  /**
   * Run the crawler and return the results. Ctrl+C pauses gracefully (waiting for active requests), a second Ctrl+C
   * stops immediately. With `crawldir` set, a checkpoint is saved on pause so the next run resumes from it.
   */
  async start(): Promise<CrawlResult> {
    this.ensureInitialized();
    const onSigint = () => {
      if (this.engine) this.engine.requestPause();
      else process.exit(130);
    };
    process.on("SIGINT", onSigint);
    try {
      return await withLogger(this.logger, async () => {
        this.engine = new CrawlerEngine(this, this.sessionManager, this.crawldir, this.interval);
        try {
          const stats = await this.engine.crawl();
          return new CrawlResult(stats, this.engine.items, this.engine.paused);
        } finally {
          this.engine = null;
        }
      });
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  /**
   * Stream items as they're scraped, ideal for long-running crawlers or building applications on top of crawlers.
   * Access `crawler.stats` during the iteration for real-time statistics.
   */
  async *stream(): AsyncGenerator<Item> {
    this.ensureInitialized();
    const engine = new CrawlerEngine(this, this.sessionManager, this.crawldir, this.interval);
    this.engine = engine;
    const iterator = withLogger(this.logger, () => engine.stream());
    try {
      for (;;) {
        const next = await withLogger(this.logger, () => iterator.next());
        if (next.done) break;
        yield next.value;
      }
    } finally {
      await iterator.return(undefined);
      this.engine = null;
    }
  }

  /** The current crawl stats (works during streaming) */
  get stats(): CrawlStats {
    if (this.engine) return this.engine.stats;
    throw new Error("No active crawl. Use this property inside `for await (const item of crawler.stream())`");
  }
}
