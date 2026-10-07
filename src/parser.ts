import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { log, LogLevel } from "./core/logger.js";
import { similarity } from "./core/sequence-matcher.js";
import {
  defaultTrackStoreFactory,
  elementToDict,
  TrackStore,
  type ElementData,
  type TrackStoreFactory,
} from "./core/storage.js";
import { AttributeMap, cleanSpaces, TextValue, TextValueList, type RegexInput, type ReOptions } from "./core/text.js";
import { cssSelect, splitSelectors, SelectorSyntaxError } from "./dom/css.js";
import { parseHTML } from "./dom/html.js";
import { Attr, Element, Text, ELEMENT_NODE, TEXT_NODE, CDATA_SECTION_NODE, type Document } from "./dom/nodes.js";
import { prettifyHTML, serializeHTML } from "./dom/serializer.js";
import { xpathSelect, type XPathVariables } from "./dom/xpath.js";

export { SelectorSyntaxError };

/** A node a `Node` can wrap: an element, or a text/attribute node returned by `::text`, `::attr()`, or XPath */
export type NodeRoot = Element | Text | Attr;

export interface NodeOptions {
  /** The URL of the page, used for joining relative URLs and separating tracking data per website */
  url?: string;
  /** The encoding used to decode bytes content (default `utf-8`) */
  encoding?: string;
  /** Keep HTML comments while parsing (dropped by default) */
  keepComments?: boolean;
  /** Kept for API compatibility, HTML5 parsing turns CDATA into comments outside SVG/MathML anyway */
  keepCdata?: boolean;
  /** Kept for API compatibility, there's no document size limit to lift in the HTML5 parser */
  hugeTree?: boolean;
  /** Globally enable the tracking features (element relocation after website changes) */
  track?: boolean;
  /** Factory that builds the storage used by the tracking features (SQLite by default) */
  storage?: TrackStoreFactory;
  /** Arguments passed to the storage factory */
  storageArgs?: Record<string, unknown>;
  /** @internal Wrap an existing node instead of parsing content */
  root?: NodeRoot;
  /** @internal Share an existing storage instance */
  _storage?: TrackStore | null;
}

export interface SelectOptions {
  /** A string used to save/retrieve the element's data in tracking mode, the selector is used otherwise */
  identifier?: string;
  /** Try to relocate the element if it was saved before and the selector doesn't match anymore */
  track?: boolean;
  /** Automatically save new elements for `track` later */
  saveTrack?: boolean;
  /** The minimum similarity (in percent) accepted while relocating (default 40) */
  threshold?: number;
}

export interface XPathOptions extends SelectOptions {
  /** Values for the XPath variables used in the expression, e.g. `$name` */
  variables?: XPathVariables;
}

export interface GetAllTextOptions {
  separator?: string;
  strip?: boolean;
  ignoreTags?: string[];
  validValues?: boolean;
}

export interface FindSimilarOptions {
  similarityThreshold?: number;
  ignoreAttributes?: string[];
  matchText?: boolean;
}

export interface FindByTextOptions {
  firstMatch?: boolean;
  partial?: boolean;
  caseSensitive?: boolean;
  cleanMatch?: boolean;
}

export type FindArgument =
  | string
  | readonly string[]
  | RegExp
  | ((element: Node) => unknown)
  | Record<string, string>;

/** Where tracking data is stored by default; override with the `ARACHNE_STORAGE` environment variable */
export function defaultTrackFile(): string {
  const configured = process.env.ARACHNE_STORAGE;
  if (configured) return configured;
  const dir = join(homedir(), ".arachne");
  mkdirSync(dir, { recursive: true });
  return join(dir, "tracked_elements.db");
}

const TRACKING_DISABLED_ERROR =
  "Tracking is off for this node. Create a new one with `track: true` to use it.";

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ").replace(/\r/g, "\\D ").replace(/\f/g, "\\C ");
}

function decodeBody(content: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(content);
  } catch {
    log.warning(`Unknown encoding "${encoding}", falling back to utf-8`);
    return new TextDecoder("utf-8", { fatal: false }).decode(content);
  }
}

function isTextLike(node: NodeRoot): node is Text | Attr {
  return node.nodeType !== ELEMENT_NODE;
}

function nodeString(node: Text | Attr): string {
  return node instanceof Attr ? node.value : node.data;
}

function dictDiff(a: Record<string, string>, b: Record<string, string>): number {
  let score = similarity(Object.keys(a), Object.keys(b)) * 0.5;
  score += similarity(Object.values(a), Object.values(b)) * 0.5;
  return score;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The main class that wraps HTML content. Search it with CSS selectors, XPath, text, regex, or filters, navigate the
 * tree, and use the tracking features to find elements again after the website changes.
 */
export class Node {
  url: string;
  encoding: string;
  /** @internal */
  _root: NodeRoot;
  /** @internal */
  _storage: TrackStore | null = null;
  /** @internal */
  _rawBody: string | Uint8Array = "";
  private readonly trackingEnabled: boolean;
  private readonly keepComments: boolean;
  private readonly keepCdata: boolean;
  private cachedText: TextValue | null = null;
  private cachedAttributes: AttributeMap | null = null;

  constructor(content?: string | Uint8Array | null, options: NodeOptions = {}) {
    const { url = "", encoding = "utf-8", keepComments = false, keepCdata = false, track = false } = options;
    if (!options.root && (content === null || content === undefined)) {
      throw new TypeError("Node class needs HTML content, or root arguments to work");
    }

    this.url = url;
    this.encoding = encoding;
    this.keepComments = Boolean(keepComments);
    this.keepCdata = Boolean(keepCdata);

    if (options.root) {
      this._root = options.root;
      if (isTextLike(options.root)) {
        this.trackingEnabled = false;
        return;
      }
    } else {
      let body: string;
      if (typeof content === "string") {
        body = content.trim().replace(/\x00/g, "");
      } else if (content instanceof Uint8Array) {
        body = decodeBody(content, encoding).replace(/\x00/g, "");
      } else {
        throw new TypeError(`content argument must be a string or bytes, got ${typeof content}`);
      }
      const doc = parseHTML(body || "<html></html>", { keepComments: this.keepComments });
      this._root = doc.documentElement!;
      this._rawBody = content as string | Uint8Array;
    }

    this.trackingEnabled = Boolean(track);
    if (this.trackingEnabled) {
      if (options._storage) {
        this._storage = options._storage;
      } else {
        const factory = options.storage ?? defaultTrackStoreFactory;
        if (typeof factory !== "function") throw new TypeError("`storage` must be a factory function returning a TrackStore");
        const args = options.storageArgs ?? { trackFile: defaultTrackFile(), url };
        const storage = factory(args);
        if (!(storage instanceof TrackStore)) throw new TypeError("Storage system must inherit from `TrackStore`");
        this._storage = storage;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Node helpers

  /** Whether this selector wraps a text/attribute node (results of `::text`, `::attr()`, `/text()`, `/@attr`) */
  get isTextNode(): boolean {
    return isTextLike(this._root);
  }

  private get element(): Element {
    return this._root as Element;
  }

  private wrap(node: NodeRoot): Node {
    return new Node(null, {
      root: node,
      url: this.url,
      encoding: this.encoding,
      track: this.trackingEnabled,
      _storage: this._storage,
      keepComments: this.keepComments,
      keepCdata: this.keepCdata,
    });
  }

  private wrapAll(nodes: Iterable<NodeRoot>): NodeList {
    const out = new NodeList();
    for (const node of nodes) out.push(this.wrap(node));
    return out;
  }

  /** The document that holds this node */
  get document(): Document | null {
    return this._root.ownerDocument;
  }

  /** Get an attribute's value, throws when the element doesn't have it */
  attr(name: string): TextValue {
    if (this.isTextNode) throw new TypeError("Text nodes do not have attributes");
    const value = this.attrib.get(name);
    if (value === undefined) throw new RangeError(`Attribute "${name}" not found`);
    return value;
  }

  /** Check if the element has an attribute */
  hasAttr(name: string): boolean {
    if (this.isTextNode) return false;
    return this.attrib.has(name);
  }

  /** The tag name of the element (`#text` for text nodes) */
  get tag(): string {
    if (this.isTextNode) return "#text";
    return this.element.tagName;
  }

  /** The text directly inside the element, before its first child */
  get text(): TextValue {
    if (this.isTextNode) return new TextValue(nodeString(this._root as Text | Attr));
    if (this.cachedText === null) this.cachedText = new TextValue(this.element.leadingText);
    return this.cachedText;
  }

  /** Get all the text inside the element, concatenated using the given separator */
  getAllText(options: GetAllTextOptions = {}): TextValue {
    const { separator = "\n", strip = false, ignoreTags = ["script", "style"], validValues = true } = options;
    if (this.isTextNode) return new TextValue(nodeString(this._root as Text | Attr));

    const ignored = new Set<Element>();
    if (ignoreTags.length) {
      const tags = new Set(ignoreTags);
      const consider = (element: Element) => {
        if (tags.has(element.tagName) && !ignored.has(element)) {
          ignored.add(element);
          for (const inner of element.descendantElements()) ignored.add(inner);
        }
      };
      consider(this.element);
      for (const element of this.element.descendantElements()) consider(element);
    }

    const strings: string[] = [];
    for (const node of this.element.descendants()) {
      if (node.nodeType !== TEXT_NODE && node.nodeType !== CDATA_SECTION_NODE) continue;
      const text = (node as Text).data;
      const parent = node.parentElement;
      if (!text || !parent || ignored.has(parent)) continue;
      const processed = strip ? text.trim() : text;
      if (!validValues || processed.trim()) strings.push(processed);
    }
    return new TextValue(strings.join(separator));
  }

  /** Join this selector's URL with a relative URL to form an absolute one */
  urljoin(relativeUrl: string): string {
    if (!this.url) return relativeUrl;
    try {
      return new URL(relativeUrl, this.url).href;
    } catch {
      return relativeUrl;
    }
  }

  /** The attributes of the element */
  get attrib(): AttributeMap {
    if (this.isTextNode) return new AttributeMap();
    if (!this.cachedAttributes) {
      this.cachedAttributes = new AttributeMap(this.element.attributes.map((attr) => [attr.name, attr.value] as [string, string]));
    }
    return this.cachedAttributes;
  }

  /** The outer HTML of the element */
  get htmlContent(): TextValue {
    if (this.isTextNode) return new TextValue(nodeString(this._root as Text | Attr));
    return new TextValue(serializeHTML(this.element).trim());
  }

  /** The raw body this selector was created from, without any processing */
  get body(): string | Uint8Array {
    if (this.isTextNode) return "";
    return this._rawBody;
  }

  /** A prettified version of the element's HTML */
  prettify(): TextValue {
    if (this.isTextNode) return new TextValue(nodeString(this._root as Text | Attr));
    return new TextValue(prettifyHTML(this.element));
  }

  /** Check if the element has a specific class */
  hasClass(className: string): boolean {
    if (this.isTextNode) return false;
    return this.element.classList.includes(className);
  }

  /** The direct parent element, or `null` */
  get parent(): Node | null {
    const root = this._root;
    const parent = root instanceof Attr ? root.ownerElement : root.parentElement;
    return parent ? this.wrap(parent) : null;
  }

  /** All the elements under this element in the tree */
  get belowElements(): NodeList {
    if (this.isTextNode) return new NodeList();
    return this.wrapAll(this.element.descendantElements());
  }

  /** The children elements of this element */
  get children(): NodeList {
    if (this.isTextNode) return new NodeList();
    return this.wrapAll(this.element.children);
  }

  /** The other children of this element's parent */
  get siblings(): NodeList {
    const parent = this.parent;
    if (!parent) return new NodeList();
    return parent.children.filter((child) => child._root !== this._root);
  }

  /** Iterate over the ancestors of the element, starting with its parent */
  *iterancestors(): Generator<Node> {
    if (this.isTextNode) return;
    for (const ancestor of this.element.ancestors()) yield this.wrap(ancestor);
  }

  /** Return the first ancestor that matches the passed function, or `null` */
  findAncestor(func: (ancestor: Node) => unknown): Node | null {
    for (const ancestor of this.iterancestors()) if (func(ancestor)) return ancestor;
    return null;
  }

  /** The ancestors leading to this element, starting with its parent */
  get path(): NodeList {
    const out = new NodeList();
    for (const ancestor of this.iterancestors()) out.push(ancestor);
    return out;
  }

  /** The next sibling element, or `null` */
  get next(): Node | null {
    if (this.isTextNode) return null;
    let next = this.element.nextSibling;
    while (next && next.nodeType !== ELEMENT_NODE) next = next.nextSibling;
    return next ? this.wrap(next as Element) : null;
  }

  /** The previous sibling element, or `null` */
  get previous(): Node | null {
    if (this.isTextNode) return null;
    let prev = this.element.previousSibling;
    while (prev && prev.nodeType !== ELEMENT_NODE) prev = prev.previousSibling;
    return prev ? this.wrap(prev as Element) : null;
  }

  /** Serialize this node: the text for text nodes, the outer HTML otherwise */
  get(): TextValue {
    if (this.isTextNode) return new TextValue(nodeString(this._root as Text | Attr));
    return this.htmlContent;
  }

  /** A single-element list holding this node's serialized string */
  getall(): TextValueList {
    const out = new TextValueList();
    out.push(this.get());
    return out;
  }

  extract(): TextValueList {
    return this.getall();
  }

  extractFirst(): TextValue {
    return this.get();
  }

  toString(): string {
    return this.get().valueOf();
  }

  [inspect.custom](): string {
    const limit = 40;
    const shorten = (text: string) => (text.length > limit ? `${text.slice(0, limit).trim()}...` : text);
    if (this.isTextNode) return `<text='${shorten(nodeString(this._root as Text | Attr))}'>`;
    let data = `<data='${shorten(cleanSpaces(this.htmlContent.valueOf()))}'`;
    const parent = this.parent;
    if (parent) data += ` parent='${shorten(cleanSpaces(parent.htmlContent.valueOf()))}'`;
    return `${data}>`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Selection

  /** Search the current tree with CSS3 selectors (supports `::text` and `::attr(name)` pseudo-elements) */
  css(selector: string, options: SelectOptions = {}): NodeList {
    if (this.isTextNode) return new NodeList();
    const { identifier = "", track = false, saveTrack = false, threshold = 40 } = options;

    if (!this.trackingEnabled || !selector.includes(",")) {
      return this.handleSelection(() => cssSelect(selector, this.element), identifier || selector, track, saveTrack, threshold);
    }

    // Each selector of a combined one is handled separately so the tracking data is saved correctly for each
    const results = new NodeList();
    for (const single of splitSelectors(selector)) {
      results.push(
        ...this.handleSelection(() => cssSelect(single, this.element), identifier || single, track, saveTrack, threshold),
      );
    }
    return results;
  }

  /** Search the current tree with XPath selectors */
  xpath(selector: string, options: XPathOptions = {}): NodeList {
    if (this.isTextNode) return new NodeList();
    const { identifier = "", track = false, saveTrack = false, threshold = 40, variables } = options;
    return this.handleSelection(
      () => {
        const result = xpathSelect(selector, this.element, variables);
        if (!Array.isArray(result)) {
          throw new SelectorSyntaxError(`XPath expression '${selector}' returned a ${typeof result}, not a node-set`);
        }
        return result;
      },
      identifier || selector,
      track,
      saveTrack,
      threshold,
    );
  }

  /** Evaluate an XPath expression that returns a value instead of nodes, e.g. `count(//a)` or `string(//title)` */
  xpathValue(selector: string, variables?: XPathVariables): string | number | boolean | NodeList {
    if (this.isTextNode) return new NodeList();
    const result = xpathSelect(selector, this.element, variables);
    return Array.isArray(result) ? this.wrapAll(result) : result;
  }

  private handleSelection(
    run: () => NodeRoot[],
    identifier: string,
    track: boolean,
    saveTrack: boolean,
    threshold: number,
  ): NodeList {
    let elements: NodeRoot[] = run();
    if (elements.length) {
      if (!this.trackingEnabled && saveTrack) {
        log.warning(
          "`saveTrack` has no effect because tracking is off for this node. Pass `track: true` when creating it.",
        );
      } else if (this.trackingEnabled && saveTrack) {
        this.save(elements[0]!, identifier);
      }
      return this.wrapAll(elements);
    }
    if (this.trackingEnabled) {
      if (track) {
        const elementData = this.retrieve(identifier);
        if (elementData) {
          elements = this.relocate(elementData, { threshold });
          if (elements.length && saveTrack) this.save(elements[0]!, identifier);
        }
      }
      return this.wrapAll(elements);
    }
    if (track) {
      log.warning(
        "`track` has no effect because tracking is off for this node. Pass `track: true` when creating it.",
      );
    } else if (saveTrack) {
      log.warning(
        "`saveTrack` has no effect because tracking is off for this node. Pass `track: true` when creating it.",
      );
    }
    return this.wrapAll(elements);
  }

  /**
   * Find elements by filters: tag names, arrays of tag names, regex patterns matched against the text, filter functions,
   * and objects of attributes. Leave it empty to select everything.
   */
  findAll(...args: FindArgument[]): NodeList {
    if (this.isTextNode) return new NodeList();
    if (!args.length) {
      throw new TypeError("You have to pass something to search with, like tag name(s), tag attributes, or both.");
    }

    const attributes: Record<string, string> = {};
    const tags = new Set<string>();
    const patterns: RegExp[] = [];
    const functions: ((element: Node) => unknown)[] = [];

    for (const arg of args) {
      if (typeof arg === "string") {
        tags.add(arg);
      } else if (Array.isArray(arg)) {
        if (!arg.every((item) => typeof item === "string")) {
          throw new TypeError("Nested Iterables are not accepted, only iterables of tag names are accepted");
        }
        for (const tag of arg) tags.add(tag);
      } else if (arg instanceof RegExp) {
        patterns.push(arg);
      } else if (typeof arg === "function") {
        if (arg.length === 0) {
          throw new TypeError("Callable filter function must have at least one argument to take `Node` objects.");
        }
        functions.push(arg as (element: Node) => unknown);
      } else if (arg && typeof arg === "object") {
        for (const [key, value] of Object.entries(arg)) {
          if (typeof value !== "string") {
            throw new TypeError("Nested dictionaries are not accepted, only string keys and string values are accepted");
          }
          attributes[key] = value;
        }
      } else {
        throw new TypeError(`Argument with type "${typeof arg}" is not accepted, please read the docs.`);
      }
    }

    // It's easier and faster to build a selector than traversing the tree
    const selectors: string[] = [];
    for (const tag of tags.size ? tags : new Set(["*"])) {
      let selector = tag;
      for (const [key, value] of Object.entries(attributes)) {
        // Keys aren't escaped so patterns like {"href*": "/p/"} keep working
        const classNames = key === "class" ? value.split(/\s+/).filter(Boolean) : [];
        if (classNames.length) {
          // `class` is a space-separated list, so each name is matched with `~=`
          selector += classNames.map((name) => `[class~="${escapeCssString(name)}"]`).join("");
        } else {
          selector += `[${key}="${escapeCssString(value)}"]`;
        }
      }
      if (selector !== "*") selectors.push(selector);
    }

    let results: NodeList = selectors.length ? this.css(selectors.join(", ")) : this.belowElements;
    if (results.length || !selectors.length) {
      for (const pattern of patterns) results = results.filter((el) => el.text.re(pattern, { checkMatch: true }));
      for (const fn of functions) results = results.filter(fn);
    }
    return results;
  }

  /** Same as `findAll()` but return the first result only, or `null` */
  find(...args: FindArgument[]): Node | null {
    return this.findAll(...args)[0] ?? null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tracking

  private similarityScore(original: ElementData, candidate: Element): number {
    let score = 0;
    let checks = 0;
    const data = elementToDict(candidate);

    score += original.tag === data.tag ? 1 : 0;
    checks++;

    if (original.text) {
      score += similarity(original.text, data.text ?? "");
      checks++;
    }

    // If both don't have attributes, it still counts for something!
    score += dictDiff(original.attributes, data.attributes);
    checks++;

    // Separate similarity tests for class, id, href,... this helps with full structural changes
    for (const attrib of ["class", "id", "href", "src"]) {
      if (original.attributes[attrib]) {
        score += similarity(original.attributes[attrib]!, data.attributes[attrib] ?? "");
        checks++;
      }
    }

    score += similarity(original.path, data.path);
    checks++;

    if (original.parent_name && data.parent_name) {
      score += similarity(original.parent_name, data.parent_name);
      checks++;
      score += dictDiff(original.parent_attribs ?? {}, data.parent_attribs ?? {});
      checks++;
      if (original.parent_text) {
        score += similarity(original.parent_text, data.parent_text ?? "");
        checks++;
      }
    }

    if (original.siblings?.length) {
      score += similarity(original.siblings, data.siblings ?? []);
      checks++;
    }

    return round2((score / checks) * 100);
  }

  /** Search the tree again for an element, used automatically when the page structure changes */
  relocate(element: ElementData | Element | Node, options: { threshold?: number; selectorType: true }): NodeList;
  relocate(element: ElementData | Element | Node, options?: { threshold?: number; selectorType?: false }): Element[];
  relocate(
    element: ElementData | Element | Node,
    options: { threshold?: number; selectorType?: boolean } = {},
  ): Element[] | NodeList {
    const { threshold = 40, selectorType = false } = options;
    let original: ElementData;
    if (element instanceof Node) original = elementToDict(element._root as Element);
    else if (element instanceof Element) original = elementToDict(element);
    else original = element;

    const scoreTable = new Map<number, Element[]>();
    for (const node of this.element.descendantElements()) {
      const score = this.similarityScore(original, node);
      const bucket = scoreTable.get(score);
      if (bucket) bucket.push(node);
      else scoreTable.set(score, [node]);
    }

    if (scoreTable.size) {
      const highest = Math.max(...scoreTable.keys());
      if (highest >= threshold) {
        if (log.isEnabledFor(LogLevel.DEBUG)) {
          log.debug(`Highest probability was ${highest}%`);
          log.debug("Top 5 best matching elements are: ");
          for (const percent of [...scoreTable.keys()].sort((a, b) => b - a).slice(0, 5)) {
            log.debug(`${percent} -> ${inspect(this.wrapAll(scoreTable.get(percent)!))}`);
          }
        }
        const best = scoreTable.get(highest)!;
        return selectorType ? this.wrapAll(best) : best;
      }
      log.warning(
        `Tracking found no element above the ${threshold}% similarity threshold ` +
          `(top score: ${highest}%). Lower \`threshold\` if this is the right element.`,
      );
    }
    return selectorType ? new NodeList() : [];
  }

  /** Save the element's unique properties to the storage for relocation later */
  save(element: Node | NodeRoot, identifier: string): void {
    if (!this.trackingEnabled || !this._storage) throw new Error(TRACKING_DISABLED_ERROR);
    let target: NodeRoot = element instanceof Node ? element._root : element;
    if (target instanceof Attr) target = target.ownerElement!;
    else if (target instanceof Text) target = target.parentElement!;
    this._storage.save(target as Element, identifier);
  }

  /** Retrieve the saved unique properties of an element by its identifier */
  retrieve(identifier: string): ElementData | null {
    if (!this.trackingEnabled || !this._storage) throw new Error(TRACKING_DISABLED_ERROR);
    return this._storage.retrieve(identifier);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Text operations

  /** Parse the body/text as JSON */
  json<T = any>(): T {
    if (this.isTextNode) return new TextValue(nodeString(this._root as Text | Attr)).json<T>();
    const raw = this._rawBody;
    if (raw && (typeof raw === "string" ? raw.length : raw.byteLength)) {
      const text = typeof raw === "string" ? raw : decodeBody(raw, this.encoding);
      return new TextValue(text).json<T>();
    }
    if (this.text.length) return this.text.json<T>();
    return this.getAllText({ strip: true }).json<T>();
  }

  /** Apply the regex to the element's text and return the matches */
  re(regex: RegexInput, options: ReOptions = {}): TextValueList {
    return this.text.re(regex, options);
  }

  /** Apply the regex to the element's text and return the first match, or the default value */
  reFirst<D = null>(regex: RegexInput, defaultValue: D = null as D, options: ReOptions = {}): TextValue | D {
    return this.text.reFirst(regex, defaultValue, options);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Similar elements & text search

  private attributesWithout(element: Element, ignore: Set<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const attr of element.attributes) if (!ignore.has(attr.name)) out[attr.name] = attr.value;
    return out;
  }

  private areAlike(
    original: Element,
    originalAttributes: Record<string, string>,
    candidate: Element,
    ignore: Set<string>,
    threshold: number,
    matchText: boolean,
  ): boolean {
    const candidateAttributes = this.attributesWithout(candidate, ignore);
    let score = 0;
    let checks = 0;
    const originalKeys = Object.keys(originalAttributes);
    if (originalKeys.length) {
      for (const key of originalKeys) score += similarity(originalAttributes[key]!, candidateAttributes[key] ?? "");
      // `max` so candidates with extra attributes are penalized and ones with fewer don't get inflated scores
      checks += Math.max(originalKeys.length, Object.keys(candidateAttributes).length);
    } else if (!Object.keys(candidateAttributes).length) {
      // Both don't have attributes, this must mean something
      score += 1;
      checks += 1;
    }
    if (matchText) {
      score += similarity(cleanSpaces(original.leadingText), cleanSpaces(candidate.leadingText));
      checks++;
    }
    return checks ? round2(score / checks) >= threshold : false;
  }

  /**
   * Find elements at the same tree depth with the same tag, parent tag, and grandparent tag, then keep the ones whose
   * attributes match this element's with a similarity higher than the threshold. Inspired by AutoScraper.
   */
  findSimilar(options: FindSimilarOptions = {}): NodeList {
    if (this.isTextNode) return new NodeList();
    const { similarityThreshold = 0.2, ignoreAttributes = ["href", "src"], matchText = false } = options;
    const root = this.element;
    const ignore = new Set(ignoreAttributes);
    const depth = [...root.ancestors()].length;
    const targetAttributes = this.attributesWithout(root, ignore);
    const parent = root.parentElement;
    const grandparent = parent?.parentElement ?? null;
    const doc = root.ownerDocument;

    const similar: Element[] = [];
    const candidates = doc ? doc.descendantElements() : root.descendantElements();
    for (const candidate of candidates) {
      if (candidate === root || candidate.tagName !== root.tagName) continue;
      const candidateParent = candidate.parentElement;
      if (parent && candidateParent?.tagName !== parent.tagName) continue;
      if (grandparent && candidateParent?.parentElement?.tagName !== grandparent.tagName) continue;
      if ([...candidate.ancestors()].length !== depth) continue;
      if (this.areAlike(root, targetAttributes, candidate, ignore, similarityThreshold, matchText)) similar.push(candidate);
    }
    return this.wrapAll(similar);
  }

  private textTargets(): Element[] {
    // Elements whose first text node has non-whitespace content, like `.//*[normalize-space(text())]`
    const out: Element[] = [];
    for (const element of this.element.descendantElements()) {
      for (const child of element.childNodes) {
        if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
          if ((child as Text).data.trim()) out.push(element);
          break;
        }
      }
    }
    return out;
  }

  /** Find elements whose text fully/partially matches the input */
  findByText(text: string, options: FindByTextOptions & { firstMatch: false }): NodeList;
  findByText(text: string, options?: FindByTextOptions & { firstMatch?: true }): Node | null;
  findByText(text: string, options: FindByTextOptions = {}): NodeList | Node | null {
    const { firstMatch = true, partial = false, caseSensitive = false, cleanMatch = true } = options;
    if (this.isTextNode) return firstMatch ? null : new NodeList();
    const query = caseSensitive ? text : text.toLowerCase();
    const results = new NodeList();
    for (const element of this.textTargets()) {
      const node = this.wrap(element);
      let nodeText = node.text.valueOf();
      if (cleanMatch) nodeText = node.text.clean().valueOf();
      if (!caseSensitive) nodeText = nodeText.toLowerCase();
      if (partial ? nodeText.includes(query) : nodeText === query) {
        results.push(node);
        if (firstMatch) break;
      }
    }
    return firstMatch ? (results[0] ?? null) : results;
  }

  /** Find elements whose text matches the regex pattern */
  findByRegex(query: RegexInput, options: Omit<FindByTextOptions, "partial"> & { firstMatch: false }): NodeList;
  findByRegex(query: RegexInput, options?: Omit<FindByTextOptions, "partial"> & { firstMatch?: true }): Node | null;
  findByRegex(query: RegexInput, options: Omit<FindByTextOptions, "partial"> = {}): NodeList | Node | null {
    const { firstMatch = true, caseSensitive = false, cleanMatch = true } = options;
    if (this.isTextNode) return firstMatch ? null : new NodeList();
    const results = new NodeList();
    for (const element of this.textTargets()) {
      const node = this.wrap(element);
      if (node.text.re(query, { checkMatch: true, cleanMatch, caseSensitive })) {
        results.push(node);
        if (firstMatch) break;
      }
    }
    return firstMatch ? (results[0] ?? null) : results;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // CSS/XPath generation (trying to generate selectors like Firefox or maybe cleaner ones)

  private generalSelection(selection: "css" | "xpath" = "css", fullPath = false): string {
    if (this.isTextNode) return "";
    const css = selection === "css";
    const parts: string[] = [];
    const finish = (prefix: string) => (css ? [...parts].reverse().join(" > ") : prefix + [...parts].reverse().join("/"));

    let target: Element | null = this.element;
    while (target) {
      const parent: Element | null = target.parentElement;
      if (!parent) break;
      const id = target.getAttribute("id");
      if (id) {
        parts.push(css ? `#${id}` : fullPath ? `*[@id='${id}']` : `[@id='${id}']`);
        if (!fullPath) return finish("//*");
      } else {
        let part = target.tagName;
        let counter = 0;
        for (const child of parent.children) {
          if (child.tagName === target.tagName) counter++;
          if (child === target) break;
        }
        let total = 0;
        for (const child of parent.children) if (child.tagName === target.tagName) total++;
        // Number the element whenever siblings share its tag, so the selector stays unique
        if (total > 1) part += css ? `:nth-of-type(${counter})` : `[${counter}]`;
        parts.push(part);
      }
      target = parent;
      if (target.tagName === "html") return finish("//");
    }
    return finish("//");
  }

  /** A CSS selector for the current element */
  get generateCssSelector(): string {
    return this.generalSelection("css");
  }

  /** A complete CSS selector for the current element */
  get generateFullCssSelector(): string {
    return this.generalSelection("css", true);
  }

  /** An XPath selector for the current element */
  get generateXpathSelector(): string {
    return this.generalSelection("xpath");
  }

  /** A complete XPath selector for the current element */
  get generateFullXpathSelector(): string {
    return this.generalSelection("xpath", true);
  }
}

/** A list of `Node` objects with extra methods */
export class NodeList extends Array<Node> {
  static override get [Symbol.species]() {
    return Array;
  }

  /** Build a `NodeList` list from any iterable of selectors */
  static fromIterable(items: Iterable<Node>): NodeList {
    const out = new NodeList();
    for (const item of items) out.push(item);
    return out;
  }

  /** Call `.xpath()` on each element and return the results flattened */
  xpath(selector: string, options: XPathOptions = {}): NodeList {
    const out = new NodeList();
    for (const element of this) {
      out.push(...element.xpath(selector, { ...options, identifier: options.identifier || selector, track: false }));
    }
    return out;
  }

  /** Call `.css()` on each element and return the results flattened */
  css(selector: string, options: SelectOptions = {}): NodeList {
    const out = new NodeList();
    for (const element of this) {
      out.push(...element.css(selector, { ...options, identifier: options.identifier || selector, track: false }));
    }
    return out;
  }

  /** Call `.re()` on each element and return the results flattened */
  re(regex: RegexInput, options: ReOptions = {}): TextValueList {
    const out = new TextValueList();
    for (const element of this) out.push(...element.re(regex, options));
    return out;
  }

  /** Call `.re()` on each element and return the first result, or the default value */
  reFirst<D = null>(regex: RegexInput, defaultValue: D = null as D, options: ReOptions = {}): TextValue | D {
    for (const element of this) {
      const results = element.re(regex, options);
      if (results.length) return results[0]!;
    }
    return defaultValue;
  }

  /** Return the first element that matches the passed function, or `null` */
  search(func: (element: Node) => unknown): Node | null {
    for (const element of this) if (func(element)) return element;
    return null;
  }

  /** Keep the elements that match the passed function */
  override filter(func: (element: Node, index: number, array: Node[]) => unknown): NodeList {
    const out = new NodeList();
    this.forEach((element, index, array) => {
      if (func(element, index, array)) out.push(element);
    });
    return out;
  }

  override slice(start?: number, end?: number): NodeList {
    return NodeList.fromIterable(Array.prototype.slice.call(this, start, end) as Node[]);
  }

  /** The serialized string of the first element, or the default value when the list is empty */
  get<D = null>(defaultValue: D = null as D): TextValue | D {
    return this.length ? this[0]!.get() : defaultValue;
  }

  /** Serialize all elements */
  getall(): TextValueList {
    const out = new TextValueList();
    for (const element of this) out.push(element.get());
    return out;
  }

  extract(): TextValueList {
    return this.getall();
  }

  extractFirst<D = null>(defaultValue: D = null as D): TextValue | D {
    return this.get(defaultValue);
  }

  /** The first element or `null` */
  get first(): Node | null {
    return this[0] ?? null;
  }

  /** The last element or `null` */
  get last(): Node | null {
    return this[this.length - 1] ?? null;
  }
}
