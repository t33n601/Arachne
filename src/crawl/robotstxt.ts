import { createRequire } from "node:module";

import { log } from "../core/logger.js";
import type { Response } from "../transport/utils/response.js";

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}
const robotsParser = createRequire(import.meta.url)("robots-parser") as (url: string, content: string) => Robot;

/** A parsed robots.txt with the directives the crawler needs */
export class RobotsTxt {
  private readonly robot: Robot;

  constructor(
    private readonly url: string,
    private readonly content: string,
  ) {
    this.robot = robotsParser(url, content);
  }

  static parse(url: string, content: string): RobotsTxt {
    return new RobotsTxt(url, content);
  }

  canFetch(url: string, userAgent = "*"): boolean {
    return this.robot.isAllowed(url, userAgent) !== false;
  }

  crawlDelay(userAgent = "*"): number | null {
    return this.robot.getCrawlDelay(userAgent) ?? null;
  }

  /** The `Request-rate` directive as `[requests, seconds]` for the given user agent group */
  requestRate(userAgent = "*"): [number, number] | null {
    const target = userAgent.toLowerCase();
    let groupAgents: string[] = [];
    let inRules = false;
    let fallback: [number, number] | null = null;
    let matched: [number, number] | null = null;

    for (const rawLine of this.content.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === "user-agent") {
        if (inRules) {
          groupAgents = [];
          inRules = false;
        }
        groupAgents.push(value.toLowerCase());
        continue;
      }
      inRules = true;
      if (key !== "request-rate") continue;
      const match = /^(\d+)\s*\/\s*(\d+)\s*([smhd])?/i.exec(value);
      if (!match) continue;
      const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[(match[3] ?? "s").toLowerCase() as "s"] ?? 1;
      const rate: [number, number] = [Number(match[1]), Number(match[2]) * multiplier];
      if (groupAgents.includes(target) && target !== "*") matched = rate;
      else if (groupAgents.includes("*")) fallback = rate;
    }
    return matched ?? fallback;
  }

  /** `Sitemap` directives */
  get sitemaps(): string[] {
    return this.robot.getSitemaps();
  }
}

/** Fetches, parses, and caches robots.txt files */
export class RobotsTxtManager {
  private readonly cache = new Map<string, Promise<RobotsTxt>>();

  constructor(private readonly fetchFn: (url: string, sid: string) => Promise<Response>) {}

  private getParser(url: string, sid: string): Promise<RobotsTxt> {
    const parsed = new URL(url);
    const domain = parsed.host;
    let parser = this.cache.get(domain);
    if (!parser) {
      parser = this.load(`${parsed.protocol || "https:"}//${domain}/robots.txt`, sid, domain);
      this.cache.set(domain, parser);
    }
    return parser;
  }

  private async load(robotsUrl: string, sid: string, domain: string): Promise<RobotsTxt> {
    let content = "";
    try {
      const response = await this.fetchFn(robotsUrl, sid);
      if (response.status === 200) content = new TextDecoder(response.encoding || "utf-8").decode(response.body);
    } catch (e) {
      log.warning(`Failed to fetch robots.txt for ${domain}: ${(e as Error).message}`);
    }
    try {
      return RobotsTxt.parse(robotsUrl, content);
    } catch (e) {
      log.warning(`Failed to parse robots.txt for ${domain}: ${(e as Error).message}`);
      return RobotsTxt.parse(robotsUrl, "");
    }
  }

  /** Check if a URL can be fetched according to its domain's robots.txt */
  async canFetch(url: string, sid: string): Promise<boolean> {
    return (await this.getParser(url, sid)).canFetch(url, "*");
  }

  /** Both the crawl-delay and the request-rate directives */
  async getDelayDirectives(url: string, sid: string): Promise<[number | null, [number, number] | null]> {
    const parser = await this.getParser(url, sid);
    return [parser.crawlDelay("*"), parser.requestRate("*")];
  }

  /** Pre-warm the cache for a list of seed URLs concurrently */
  async prefetch(urls: string[], sid: string): Promise<void> {
    if (!urls.length) return;
    log.debug(`Pre-fetching robots.txt for ${urls.length} domain(s)`);
    await Promise.all(urls.map((url) => this.getParser(url, sid)));
  }
}
