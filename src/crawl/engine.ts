import { inspect } from "node:util";

import { log } from "../core/logger.js";
import type { Response } from "../transport/utils/response.js";
import { ResponseCacheManager } from "./cache.js";
import { CheckpointManager } from "./checkpoint.js";
import { iterateCallback, Request, type RequestCallback } from "./request.js";
import { CrawlStats, ItemList, type Item } from "./result.js";
import { RobotsTxtManager } from "./robotstxt.js";
import { Scheduler } from "./scheduler.js";
import type { SessionManager } from "./session.js";
import { AutoThrottle, parseRetryAfter } from "./throttle.js";
import type { Crawler } from "./crawler.js";

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function now(): number {
  return performance.now() / 1000;
}

/** A counting semaphore limiting concurrency */
class CapacityLimiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** An unbounded async queue used to stream items */
class AsyncChannel<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  send(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.buffer.length) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

function isItem(value: unknown): value is Item {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Request);
}

/** Orchestrates the crawling process */
export class CrawlerEngine {
  stats = new CrawlStats();
  readonly scheduler: Scheduler;
  paused = false;
  private readonly robotsManager: RobotsTxtManager | null;
  private readonly cacheManager: ResponseCacheManager | null;
  private readonly autothrottle: AutoThrottle | null;
  private readonly globalLimiter: CapacityLimiter;
  private readonly domainLimiters = new Map<string, CapacityLimiter>();
  private readonly allowedDomains: Set<string>;
  private readonly domainDelays = new Map<string, number>();
  private readonly activeTasks = new Set<Promise<void>>();
  private running = false;
  private readonly itemsList = new ItemList();
  private itemStream: AsyncChannel<Item> | null = null;
  private readonly checkpointEnabled: boolean;
  private readonly checkpointManager: CheckpointManager;
  private lastCheckpointTime = 0;
  private pauseRequested = false;
  private forceStop = false;

  constructor(
    private readonly crawler: Crawler,
    private readonly sessionManager: SessionManager,
    crawldir: string | null = null,
    interval = 300.0,
  ) {
    this.scheduler = new Scheduler(crawler.fpIncludeKwargs, crawler.fpIncludeHeaders, crawler.fpKeepFragments);

    this.robotsManager = crawler.robotsTxtObey
      ? new RobotsTxtManager((url, sid) => this.sessionManager.fetch(new Request(url, { sid })))
      : null;

    if (crawler.developmentMode) {
      this.cacheManager = new ResponseCacheManager(crawler.developmentCacheDir ?? `.arachne_cache/${crawler.name}`);
      log.warning("Development mode enabled -- responses will be cached to disk and replayed on subsequent runs");
    } else {
      this.cacheManager = null;
    }

    this.autothrottle = crawler.autothrottleEnabled
      ? new AutoThrottle(
          crawler.autothrottleStartDelay,
          crawler.autothrottleMaxDelay,
          crawler.autothrottleTargetConcurrency ?? (crawler.concurrentRequestsPerDomain || 1.0),
          crawler.autothrottleBlockBackoff,
        )
      : null;

    this.globalLimiter = new CapacityLimiter(crawler.concurrentRequests);
    this.allowedDomains = new Set(crawler.allowedDomains ?? []);
    this.checkpointEnabled = Boolean(crawldir);
    this.checkpointManager = new CheckpointManager(crawldir ?? "", interval);
  }

  private isDomainAllowed(request: Request): boolean {
    if (!this.allowedDomains.size) return true;
    let domain: string;
    try {
      domain = new URL(request.url).hostname;
    } catch {
      return false;
    }
    for (const allowed of this.allowedDomains) {
      if (domain === allowed || domain.endsWith(`.${allowed}`)) return true;
    }
    return false;
  }

  /** The effective download delay of a domain: the crawler's, or the robots.txt directives if higher */
  private async getDomainDelay(request: Request): Promise<number> {
    if (!this.robotsManager) return this.crawler.downloadDelay;
    const domain = request.domain;
    const cached = this.domainDelays.get(domain);
    if (cached !== undefined) return cached;

    const [crawlDelay, requestRate] = await this.robotsManager.getDelayDirectives(request.url, request.sid);
    let delay = this.crawler.downloadDelay;
    if (requestRate) {
      const [count, period] = requestRate;
      if (count > 0) delay = Math.max(delay, period / count);
    }
    if (crawlDelay !== null) delay = Math.max(delay, crawlDelay);
    this.domainDelays.set(domain, delay);
    return delay;
  }

  /** The per-domain concurrency limiter if enabled, the global one otherwise */
  private rateLimiter(domain: string): CapacityLimiter {
    const perDomain = this.crawler.concurrentRequestsPerDomain;
    if (!perDomain) return this.globalLimiter;
    let limiter = this.domainLimiters.get(domain);
    if (!limiter) {
      limiter = new CapacityLimiter(perDomain);
      this.domainLimiters.set(domain, limiter);
    }
    return limiter;
  }

  /** Resolve an empty session id to the default one, for consistent fingerprints */
  private normalizeRequest(request: Request): void {
    if (!request.sid) request.sid = this.sessionManager.defaultSessionId;
  }

  private async runCallbacks(request: Request, response: Response): Promise<void> {
    const callback: RequestCallback = request.callback ?? this.crawler.parse;
    try {
      for await (const result of iterateCallback(callback.call(this.crawler, response))) {
        if (result instanceof Request) {
          if (this.isDomainAllowed(result)) {
            this.normalizeRequest(result);
            this.scheduler.enqueue(result);
          } else {
            this.stats.offsiteRequestsCount++;
            log.debug(`Filtered offsite request to: ${result.url}`);
          }
        } else if (isItem(result)) {
          const processed = await this.crawler.onScrapedItem(result);
          if (processed) {
            this.stats.itemsScraped++;
            log.debug(`Scraped from ${response.toString()}\n${inspect(processed, { depth: 3 })}`);
            if (this.itemStream) this.itemStream.send(processed);
            else this.itemsList.push(processed);
          } else {
            this.stats.itemsDropped++;
            log.warning(`Dropped from ${response.toString()}\n${inspect(processed)}`);
          }
        } else if (result !== null && result !== undefined) {
          log.error(`Crawler must return Request, an object, or null, got '${typeof result}' in ${request.url}`);
        }
      }
    } catch (error) {
      log.error(`Crawler error processing ${request.url}:\n ${(error as Error).message}`, error);
      await this.crawler.onError(request, error as Error);
    }
  }

  /** Download and process a single request */
  private async processRequest(request: Request): Promise<void> {
    let floor: number;
    if (this.robotsManager) {
      if (!(await this.robotsManager.canFetch(request.url, request.sid))) {
        this.stats.robotsDisallowedCount++;
        log.info(`Request disallowed by robots.txt: ${request.url}`);
        return;
      }
      floor = await this.getDomainDelay(request);
    } else {
      floor = this.crawler.downloadDelay;
    }

    if (this.cacheManager && request._fp !== null) {
      const cached = await this.cacheManager.get(request._fp);
      if (cached) {
        cached.request = request;
        // Cached responses are rebuilt without meta, so merge the request's in as the live path does
        cached.meta = { ...request.meta, ...cached.meta };
        this.stats.cacheHits++;
        this.stats.incrementRequestsCount(request.sid || this.sessionManager.defaultSessionId);
        this.stats.incrementResponseBytes(request.domain, cached.body.byteLength);
        this.stats.incrementStatus(cached.status);
        log.debug(`Cache hit: ${request.url}`);
        await this.runCallbacks(request, cached);
        return;
      }
    }

    let response: Response | null = null;
    let latency = 0;
    await this.rateLimiter(request.domain).run(async () => {
      const delay = this.autothrottle ? this.autothrottle.delayFor(request.domain, floor) : floor;
      if (delay) await sleep(delay);

      const kwargs = request.sessionKwargs;
      if (kwargs.proxy) this.stats.proxies.push(kwargs.proxy as string);
      if (kwargs.proxies) this.stats.proxies.push({ ...(kwargs.proxies as Record<string, string>) });
      try {
        const startedAt = now();
        response = await this.sessionManager.fetch(request);
        latency = now() - startedAt;
        this.stats.incrementRequestsCount(request.sid || this.sessionManager.defaultSessionId);
        this.stats.incrementResponseBytes(request.domain, response.body.byteLength);
        this.stats.incrementStatus(response.status);
      } catch (error) {
        this.stats.failedRequestsCount++;
        await this.crawler.onError(request, error as Error);
      }
    });
    if (!response) return;
    const fetched: Response = response;

    if (this.cacheManager && request._fp !== null) {
      this.stats.cacheMisses++;
      await this.cacheManager.put(request._fp, fetched, String(request.sessionKwargs.method ?? "GET"));
    }

    const blocked = await this.crawler.isBlocked(fetched);
    if (this.autothrottle) {
      const ok = fetched.status >= 200 && fetched.status < 300 && !blocked;
      this.autothrottle.record(request.domain, latency, ok, floor, ok ? null : parseRetryAfter(fetched.headers));
    }

    if (blocked) {
      this.stats.blockedRequestsCount++;
      if (request._retryCount < this.crawler.maxBlockedRetries) {
        const retry = request.copy();
        retry._retryCount++;
        retry.priority--; // Don't retry immediately
        retry.dontFilter = true;
        delete retry.sessionKwargs.proxy;
        delete retry.sessionKwargs.proxies;
        const newRequest = await this.crawler.retryBlockedRequest(retry, fetched);
        this.normalizeRequest(newRequest);
        this.scheduler.enqueue(newRequest);
        log.info(`Scheduled blocked request for retry (${retry._retryCount}/${this.crawler.maxBlockedRetries}): ${request.url}`);
      } else {
        log.warning(`Max retries exceeded for blocked request: ${request.url}`);
      }
      return;
    }

    await this.runCallbacks(request, fetched);
  }

  private spawn(request: Request): void {
    const task = (async () => {
      try {
        await this.processRequest(request);
      } catch (error) {
        log.error(`Unexpected error processing ${request.url}: ${(error as Error).message}`, error);
      } finally {
        this.scheduler.complete(request);
      }
    })();
    this.activeTasks.add(task);
    void task.finally(() => this.activeTasks.delete(task));
  }

  /** Request a graceful pause: the first call waits for active tasks, the second forces an immediate stop */
  requestPause(): void {
    if (this.forceStop) return;
    if (this.pauseRequested) {
      this.forceStop = true;
      log.warning("Force stop requested, cancelling immediately...");
    } else {
      this.pauseRequested = true;
      log.info("Pause requested, waiting for in-flight requests to complete (press Ctrl+C again to force stop)...");
    }
  }

  private async saveCheckpoint(): Promise<void> {
    const { requests, seen } = this.scheduler.snapshot();
    await this.checkpointManager.save({ requests, seen });
    this.lastCheckpointTime = now();
  }

  private isCheckpointTime(): boolean {
    if (!this.checkpointEnabled || this.checkpointManager.interval === 0) return false;
    return now() - this.lastCheckpointTime >= this.checkpointManager.interval;
  }

  private async restoreFromCheckpoint(): Promise<boolean> {
    if (!this.checkpointEnabled) return false;
    const data = await this.checkpointManager.load();
    if (!data) return false;
    this.scheduler.restore(data);
    for (const request of data.requests) request.restoreCallback(this.crawler);
    return true;
  }

  private async prefetchRobotsTxt(): Promise<void> {
    if (!this.robotsManager || !this.crawler.startUrls.length) return;
    const seen = new Set<string>();
    const seeds: string[] = [];
    for (const url of this.crawler.startUrls) {
      try {
        const parsed = new URL(url);
        if (!seen.has(parsed.host)) {
          seen.add(parsed.host);
          seeds.push(`${parsed.protocol}//${parsed.host}/`);
        }
      } catch {
        // Invalid URLs fail later with a clear error
      }
    }
    await this.robotsManager.prefetch(seeds, this.sessionManager.defaultSessionId);
  }

  /** Run the crawler and return the crawl stats */
  async crawl(): Promise<CrawlStats> {
    this.running = true;
    this.itemsList.length = 0;
    this.paused = false;
    this.pauseRequested = false;
    this.forceStop = false;
    this.stats = new CrawlStats({ startTime: now() });
    this.domainLimiters.clear();
    this.domainDelays.clear();
    this.autothrottle?.reset();

    const resuming = await this.restoreFromCheckpoint();
    this.lastCheckpointTime = now();

    await this.sessionManager.start();
    try {
      this.stats.concurrentRequests = this.crawler.concurrentRequests;
      this.stats.concurrentRequestsPerDomain = this.crawler.concurrentRequestsPerDomain;
      this.stats.downloadDelay = this.crawler.downloadDelay;
      this.stats.autothrottleEnabled = this.crawler.autothrottleEnabled;
      await this.crawler.onStart(resuming);
      await this.prefetchRobotsTxt();

      try {
        if (!resuming) {
          for await (const request of this.crawler.startRequests()) {
            this.normalizeRequest(request);
            this.scheduler.enqueue(request);
          }
        } else {
          log.info("Resuming from checkpoint, skipping startRequests()");
        }

        while (this.running) {
          if (this.pauseRequested) {
            if (this.activeTasks.size === 0 || this.forceStop) {
              // Save the checkpoint before stopping to avoid data loss
              if (this.checkpointEnabled) {
                await this.saveCheckpoint();
                this.paused = true;
                log.info("Crawler paused, checkpoint saved");
              } else {
                log.info("Crawler stopped gracefully");
              }
              if (this.forceStop) log.warning(`Force stopping with ${this.activeTasks.size} active tasks`);
              this.running = false;
              break;
            }
            await sleep(0.05);
            continue;
          }

          if (this.isCheckpointTime()) await this.saveCheckpoint();

          if (this.scheduler.isEmpty) {
            // Empty queue + no active tasks = done
            if (this.activeTasks.size === 0) {
              this.running = false;
              log.debug("Crawler idle");
              break;
            }
            // Brief wait for callbacks to enqueue new requests
            await Promise.race([sleep(0.05), ...this.activeTasks]);
            continue;
          }

          // Only spawn tasks up to the concurrency limit, this prevents spawning thousands of waiting tasks
          if (this.activeTasks.size >= this.crawler.concurrentRequests) {
            await Promise.race([sleep(0.01), ...this.activeTasks]);
            continue;
          }

          const request = this.scheduler.dequeue();
          if (request) this.spawn(request);
        }

        if (!this.forceStop) await Promise.all(this.activeTasks);
      } finally {
        await this.crawler.onClose();
        // Clean up the checkpoint on successful completion (not paused)
        if (!this.paused && this.checkpointEnabled) await this.checkpointManager.cleanup();
      }
    } finally {
      await this.sessionManager.close();
    }

    if (this.autothrottle) this.stats.autothrottleDelays = Object.fromEntries(this.autothrottle.delays);
    this.stats.logLevelsCounter = this.crawler.logCounts();
    this.stats.endTime = now();
    log.info(JSON.stringify(this.stats.toJSON(), null, 4));
    return this.stats;
  }

  /** The scraped items */
  get items(): ItemList {
    return this.itemsList;
  }

  /** Run the crawl and yield items as they are scraped */
  async *stream(): AsyncGenerator<Item> {
    const channel = new AsyncChannel<Item>();
    this.itemStream = channel;
    let failure: unknown = null;
    const run = this.crawl()
      .catch((error) => {
        failure = error;
      })
      .finally(() => channel.close());
    try {
      for await (const item of channel) yield item;
      await run;
      if (failure) throw failure;
    } finally {
      this.itemStream = null;
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<Item> {
    return this.stream();
  }
}
