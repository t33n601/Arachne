import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { log } from "../core/logger.js";
import type { ProxyType } from "../transport/utils/proxy-rotation.js";

export type Item = Record<string, unknown>;

// Anything outside these ranges can't be represented in XML, and scraped pages are full of control characters
const XML_FORBIDDEN_CHARS = /[^\x09\x0a\x0d\x20-\u{d7ff}\u{e000}-\u{fffd}\u{10000}-\u{10ffff}]/gu;
const XML_FORBIDDEN_TAG_CHARS = /[^\p{L}\p{N}_.-]/gu;

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

/** Turn an item's value into text, serializing containers to JSON so no data is silently dropped */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof String) return value.valueOf();
  if (typeof value === "object") return JSON.stringify(value, jsonReplacer);
  return String(value);
}

/** Turn an item's key into a usable XML tag name */
function xmlTag(key: string): string {
  const tag = key.replace(XML_FORBIDDEN_TAG_CHARS, "_");
  return tag && (/\p{L}/u.test(tag[0]!) || tag[0] === "_") ? tag : `_${tag}`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(text: string): string {
  return escapeXml(text).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}

function csvField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/** A list of scraped items with export capabilities */
export class ItemList extends Array<Item> {
  static override get [Symbol.species]() {
    return Array;
  }

  /** Export the items to a JSON file */
  toJson(path: string, options: { indent?: boolean } = {}): void {
    ensureParent(path);
    writeFileSync(path, JSON.stringify([...this], jsonReplacer, options.indent ? 2 : undefined));
    log.info(`Saved ${this.length} items to ${path}`);
  }

  /** Export the items as JSON Lines (one JSON object per line) */
  toJsonl(path: string): void {
    ensureParent(path);
    writeFileSync(path, this.map((item) => `${JSON.stringify(item, jsonReplacer)}\n`).join(""));
    log.info(`Saved ${this.length} items to ${path}`);
  }

  /**
   * Export the items to a CSV file. Items that don't share the same keys are still written with the missing cells left
   * empty, and values that aren't scalars are written as JSON.
   *
   * @param fields The columns to write, defaulting to every key found in the items in the order they appeared
   */
  toCsv(path: string, options: { fields?: string[]; delimiter?: string } = {}): void {
    const delimiter = options.delimiter ?? ",";
    const columns = options.fields ?? [...new Set(this.flatMap((item) => Object.keys(item)))];
    const lines = [columns.map((column) => csvField(column, delimiter)).join(delimiter)];
    for (const item of this) lines.push(columns.map((column) => csvField(stringify(item[column]), delimiter)).join(delimiter));
    ensureParent(path);
    writeFileSync(path, `${lines.join("\r\n")}\r\n`, "utf-8");
    log.info(`Saved ${this.length} items to ${path}`);
  }

  /**
   * Export the items to an XML file. Each item becomes an element whose children are named after its keys. Keys that
   * aren't valid XML names are rewritten and keep the original in a `name` attribute.
   */
  toXml(path: string, options: { rootTag?: string; itemTag?: string; indent?: boolean } = {}): void {
    const { rootTag = "items", itemTag = "item", indent = true } = options;
    const nl = indent ? "\n" : "";
    const pad = (depth: number) => (indent ? "  ".repeat(depth) : "");
    let xml = `<?xml version='1.0' encoding='utf-8'?>\n<${rootTag}>${nl}`;
    for (const item of this) {
      const entries = Object.entries(item);
      if (!entries.length) {
        xml += `${pad(1)}<${itemTag} />${nl}`;
        continue;
      }
      xml += `${pad(1)}<${itemTag}>${nl}`;
      for (const [key, value] of entries) {
        const tag = xmlTag(key);
        const nameAttr = tag !== key ? ` name="${escapeXmlAttribute(key.replace(XML_FORBIDDEN_CHARS, ""))}"` : "";
        const text = escapeXml(stringify(value).replace(XML_FORBIDDEN_CHARS, ""));
        xml += text ? `${pad(2)}<${tag}${nameAttr}>${text}</${tag}>${nl}` : `${pad(2)}<${tag}${nameAttr} />${nl}`;
      }
      xml += `${pad(1)}</${itemTag}>${nl}`;
    }
    xml += `</${rootTag}>`;
    ensureParent(path);
    writeFileSync(path, xml, "utf-8");
    log.info(`Saved ${this.length} items to ${path}`);
  }
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Statistics of a crawl */
export class CrawlStats {
  requestsCount = 0;
  concurrentRequests = 0;
  concurrentRequestsPerDomain = 0;
  failedRequestsCount = 0;
  offsiteRequestsCount = 0;
  robotsDisallowedCount = 0;
  cacheHits = 0;
  cacheMisses = 0;
  responseBytes = 0;
  itemsScraped = 0;
  itemsDropped = 0;
  startTime = 0;
  endTime = 0;
  downloadDelay = 0;
  autothrottleEnabled = false;
  blockedRequestsCount = 0;
  autothrottleDelays: Record<string, number> = {};
  /** Put your own counters here */
  customStats: Record<string, unknown> = {};
  responseStatusCount: Record<string, number> = {};
  domainsResponseBytes: Record<string, number> = {};
  sessionsRequestsCount: Record<string, number> = {};
  proxies: (ProxyType | Record<string, string>)[] = [];
  logLevelsCounter: Record<string, number> = {};

  constructor(init: Partial<CrawlStats> = {}) {
    Object.assign(this, init);
  }

  get elapsedSeconds(): number {
    return this.endTime - this.startTime;
  }

  get requestsPerSecond(): number {
    return this.elapsedSeconds === 0 ? 0 : this.requestsCount / this.elapsedSeconds;
  }

  incrementStatus(status: number): void {
    const key = `status_${status}`;
    this.responseStatusCount[key] = (this.responseStatusCount[key] ?? 0) + 1;
  }

  incrementResponseBytes(domain: string, count: number): void {
    this.responseBytes += count;
    this.domainsResponseBytes[domain] = (this.domainsResponseBytes[domain] ?? 0) + count;
  }

  incrementRequestsCount(sid: string): void {
    this.requestsCount++;
    this.sessionsRequestsCount[sid] = (this.sessionsRequestsCount[sid] ?? 0) + 1;
  }

  toJSON(): Record<string, unknown> {
    return {
      items_scraped: this.itemsScraped,
      items_dropped: this.itemsDropped,
      elapsed_seconds: round2(this.elapsedSeconds),
      download_delay: round2(this.downloadDelay),
      autothrottle_enabled: this.autothrottleEnabled,
      autothrottle_delays: Object.fromEntries(Object.entries(this.autothrottleDelays).map(([domain, delay]) => [domain, round2(delay)])),
      concurrent_requests: this.concurrentRequests,
      concurrent_requests_per_domain: this.concurrentRequestsPerDomain,
      requests_count: this.requestsCount,
      requests_per_second: round2(this.requestsPerSecond),
      sessions_requests_count: this.sessionsRequestsCount,
      failed_requests_count: this.failedRequestsCount,
      offsite_requests_count: this.offsiteRequestsCount,
      robots_disallowed_count: this.robotsDisallowedCount,
      cache_hits: this.cacheHits,
      cache_misses: this.cacheMisses,
      blocked_requests_count: this.blockedRequestsCount,
      response_status_count: this.responseStatusCount,
      response_bytes: this.responseBytes,
      domains_response_bytes: this.domainsResponseBytes,
      proxies: this.proxies,
      custom_stats: this.customStats,
      log_count: this.logLevelsCounter,
    };
  }

  /** Same as `toJSON()` */
  toDict(): Record<string, unknown> {
    return this.toJSON();
  }
}

/** The complete result of a crawler run */
export class CrawlResult implements Iterable<Item> {
  constructor(
    readonly stats: CrawlStats,
    readonly items: ItemList,
    readonly paused = false,
  ) {}

  /** True if the crawl completed normally (not paused) */
  get completed(): boolean {
    return !this.paused;
  }

  get length(): number {
    return this.items.length;
  }

  [Symbol.iterator](): Iterator<Item> {
    return this.items[Symbol.iterator]();
  }
}
