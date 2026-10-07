import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { getDomain, parse as parseDomain } from "tldts";

import { log } from "./logger.js";
import { Element, ELEMENT_NODE, type ChildNode } from "../dom/nodes.js";

/** The unique properties of an element saved for the tracking */
export interface ElementData {
  tag: string;
  attributes: Record<string, string>;
  text: string | null;
  path: string[];
  parent_name?: string;
  parent_attribs?: Record<string, string>;
  parent_text?: string | null;
  siblings?: string[];
  children?: string[];
}

function cleanAttributes(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of element.attributes) {
    const value = attr.value.trim();
    if (value) out[attr.name] = value;
  }
  return out;
}

function elementPath(element: Element): string[] {
  const path: string[] = [];
  let current: Element | null = element;
  while (current) {
    path.unshift(current.tagName);
    current = current.parentElement;
  }
  return path;
}

function stripOrNull(text: string): string | null {
  return text ? text.trim() : null;
}

/** Collect the properties used to relocate an element later */
export function elementToDict(element: Element): ElementData {
  const parent = element.parentElement;
  const result: ElementData = {
    tag: element.tagName,
    attributes: cleanAttributes(element),
    text: stripOrNull(element.leadingText),
    path: elementPath(element),
  };
  if (parent) {
    const parentAttribs: Record<string, string> = {};
    for (const attr of parent.attributes) parentAttribs[attr.name] = attr.value;
    result.parent_name = parent.tagName;
    result.parent_attribs = parentAttribs;
    result.parent_text = stripOrNull(parent.leadingText);
    const siblings = parent.childNodes
      .filter((child: ChildNode) => child !== element && child.nodeType === ELEMENT_NODE)
      .map((child) => (child as Element).tagName);
    if (siblings.length) result.siblings = siblings;
  }
  const children = element.children.map((child) => child.tagName);
  if (children.length) result.children = children;
  return result;
}

/** Inherit from this class to build your own storage system for the tracking feature */
export abstract class TrackStore {
  readonly url: string | null;
  private baseUrlCache: string | undefined;

  /** @param url URL of the website we are working on to separate it from other websites data */
  constructor(url?: string | null) {
    this.url = url && typeof url === "string" ? url.toLowerCase() : null;
  }

  protected getBaseUrl(defaultValue = "default"): string {
    if (this.baseUrlCache !== undefined) return this.baseUrlCache;
    let base = defaultValue;
    if (this.url) {
      const url = this.url.includes("://") ? this.url : `http://${this.url}`;
      base = getDomain(url) || parseDomain(url).hostname || defaultValue;
    }
    this.baseUrlCache = base;
    return base;
  }

  /** Save the element's unique properties for retrieval and relocation later */
  abstract save(element: Element, identifier: string): void;

  /** Using the identifier, search the storage and return the unique properties of the element */
  abstract retrieve(identifier: string): ElementData | null;

  /** Release any resources held by the storage */
  close(): void {}

  /** Safer identifiers' hashing if you want to hash them in your storage system */
  static getHash(identifier: string): string {
    const normalized = Buffer.from(identifier.toLowerCase().trim(), "utf-8");
    return `${createHash("sha256").update(normalized).digest("hex")}_${normalized.length}`;
  }
}

export type TrackStoreFactory = (args: { url?: string | null; trackFile?: string; [key: string]: unknown }) => TrackStore;

/** The default storage, a SQLite database file in WAL mode */
export class SqliteTrackStore extends TrackStore {
  private static cached: { key: string; instance: SqliteTrackStore } | null = null;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(
    readonly trackFile: string,
    url?: string | null,
  ) {
    super(url);
    // Loaded lazily so the experimental SQLite module is only touched when the tracking feature is used
    const { DatabaseSync: Database } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    this.db = new Database(trackFile);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS storage (
        id INTEGER PRIMARY KEY,
        url TEXT,
        identifier TEXT,
        element_data TEXT,
        UNIQUE (url, identifier)
      )
    `);
    log.debug(`Storage system loaded with arguments (storage_file="${trackFile}", url="${url ?? ""}")`);
  }

  /** Reuse the last instance created with the same arguments, so selectors of the same website share one connection */
  static create(args: { trackFile?: string; url?: string | null }): SqliteTrackStore {
    const trackFile = args.trackFile ?? "tracked_elements.db";
    const key = `${trackFile}\u0000${args.url ?? ""}`;
    if (SqliteTrackStore.cached?.key === key && !SqliteTrackStore.cached.instance.closed) {
      return SqliteTrackStore.cached.instance;
    }
    const instance = new SqliteTrackStore(trackFile, args.url);
    SqliteTrackStore.cached = { key, instance };
    return instance;
  }

  save(element: Element, identifier: string): void {
    const data = elementToDict(element);
    this.db
      .prepare("INSERT OR REPLACE INTO storage (url, identifier, element_data) VALUES (?, ?, ?)")
      .run(this.getBaseUrl(), identifier, JSON.stringify(data));
  }

  retrieve(identifier: string): ElementData | null {
    const row = this.db
      .prepare("SELECT element_data FROM storage WHERE url = ? AND identifier = ?")
      .get(this.getBaseUrl(), identifier) as { element_data: string } | undefined;
    return row ? (JSON.parse(row.element_data) as ElementData) : null;
  }

  override close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export const defaultTrackStoreFactory: TrackStoreFactory = (args) =>
  SqliteTrackStore.create({ trackFile: args.trackFile as string | undefined, url: args.url });
