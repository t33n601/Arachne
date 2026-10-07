import { decodeHTML } from "entities";

const CLEANING_RE = /[\t\r\n]/g;
const CONSECUTIVE_SPACES_RE = / +/g;

export type RegexInput = string | RegExp;

export interface ReOptions {
  /** Replace character entity references with their corresponding character (default: true) */
  replaceEntities?: boolean;
  /** Ignore all whitespaces and consecutive spaces while matching (default: false) */
  cleanMatch?: boolean;
  /** Set to false to ignore the letters case while matching (default: true) */
  caseSensitive?: boolean;
}

const regexCache = new Map<string, RegExp>();

/** Compile a pattern the way Python's `re` does: unicode-aware when possible, global for `findall` style use */
export function compileRegex(regex: RegexInput, caseSensitive = true): RegExp {
  if (regex instanceof RegExp) {
    let flags = regex.flags;
    if (!flags.includes("g")) flags += "g";
    if (!caseSensitive && !flags.includes("i")) flags += "i";
    return flags === regex.flags ? regex : new RegExp(regex.source, flags);
  }
  const key = `${caseSensitive ? "s" : "i"}:${regex}`;
  let compiled = regexCache.get(key);
  if (compiled) return compiled;
  const flags = caseSensitive ? "g" : "gi";
  try {
    compiled = new RegExp(regex, `${flags}u`);
  } catch {
    // Patterns with escapes that are only valid outside of unicode mode
    compiled = new RegExp(regex, flags);
  }
  if (regexCache.size > 256) regexCache.delete(regexCache.keys().next().value!);
  regexCache.set(key, compiled);
  return compiled;
}

/** Python's `re.findall`: full matches without groups, the group with one group, and all groups (flattened) otherwise */
export function findAll(regex: RegExp, text: string): string[] {
  const results: string[] = [];
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    if (match.length === 1) results.push(match[0]);
    else for (let i = 1; i < match.length; i++) results.push(match[i] ?? "");
  }
  return results;
}

export function replaceEntities(text: string): string {
  return decodeHTML(text);
}

/** Remove tabs/new lines and collapse consecutive spaces, for compact text comparisons */
export function cleanSpaces(text: string): string {
  return text.replace(/\t/g, " ").replace(/[\n\r]/g, "").replace(CONSECUTIVE_SPACES_RE, " ");
}

/** A string with extra powers for scraping. Compare it with `==` or `.toString()` since it's a String object. */
export class TextValue extends String {
  constructor(value: unknown = "") {
    super(value === null || value === undefined ? "" : String(value));
  }

  /** Same as `toString()`, convenient in chains */
  get str(): string {
    return this.valueOf();
  }

  /** Python-style `strip()` that keeps the `TextValue` type, optionally stripping specific characters */
  strip(chars?: string): TextValue {
    if (!chars) return new TextValue(this.valueOf().trim());
    const escaped = chars.replace(/[\\\]^-]/g, "\\$&");
    return new TextValue(this.valueOf().replace(new RegExp(`^[${escaped}]+|[${escaped}]+$`, "g"), ""));
  }

  /** `toLowerCase()` that keeps the `TextValue` type */
  lower(): TextValue {
    return new TextValue(this.valueOf().toLowerCase());
  }

  /** `toUpperCase()` that keeps the `TextValue` type */
  upper(): TextValue {
    return new TextValue(this.valueOf().toUpperCase());
  }

  /** `split()` that returns a `TextValueList` list. Without a separator it splits on whitespace like Python */
  splitText(separator?: string | RegExp, limit?: number): TextValueList {
    const value = this.valueOf();
    const parts = separator === undefined ? value.trim().split(/\s+/).filter(Boolean) : value.split(separator, limit);
    const out = new TextValueList();
    for (const part of parts) out.push(new TextValue(part));
    return out;
  }

  /** Return a sorted version of the string */
  sort(reverse = false): TextValue {
    const chars = Array.from(this.valueOf()).sort();
    if (reverse) chars.reverse();
    return new TextValue(chars.join(""));
  }

  /** Return a new version of the string after removing all white spaces and consecutive spaces */
  clean(removeEntities = false): TextValue {
    let data = this.valueOf().replace(CLEANING_RE, " ");
    if (removeEntities) data = replaceEntities(data);
    return new TextValue(data.replace(CONSECUTIVE_SPACES_RE, " ").trim());
  }

  // For easy copy-paste from Scrapy/parsel code when needed :)
  get(_default?: unknown): TextValue {
    return this;
  }

  getall(): TextValue {
    return this;
  }

  extract(): TextValue {
    return this;
  }

  extractFirst(): TextValue {
    return this;
  }

  /** Parse the text as JSON */
  json<T = any>(): T {
    return JSON.parse(this.valueOf()) as T;
  }

  /** Apply the regex and return the matches. With `checkMatch` it only reports whether it matches. */
  re(regex: RegexInput, options: ReOptions & { checkMatch: true }): boolean;
  re(regex: RegexInput, options?: ReOptions & { checkMatch?: false }): TextValueList;
  re(regex: RegexInput, options: ReOptions & { checkMatch?: boolean } = {}): TextValueList | boolean {
    const { replaceEntities: replace = true, cleanMatch = false, caseSensitive = true, checkMatch = false } = options;
    const compiled = compileRegex(regex, caseSensitive);
    const input = cleanMatch ? this.clean().valueOf() : this.valueOf();
    if (checkMatch) {
      compiled.lastIndex = 0;
      const found = compiled.test(input);
      compiled.lastIndex = 0;
      return found;
    }
    const results = findAll(compiled, input);
    const out = new TextValueList();
    for (const s of results) out.push(new TextValue(replace ? replaceEntities(s) : s));
    return out;
  }

  /** Apply the regex and return the first match, or the default value */
  reFirst<D = null>(regex: RegexInput, defaultValue: D = null as D, options: ReOptions = {}): TextValue | D {
    const results = this.re(regex, options);
    return results.length ? results[0]! : defaultValue;
  }

  toJSON(): string {
    return this.valueOf();
  }
}

/** A list of `TextValue` objects with some extra methods */
export class TextValueList extends Array<TextValue> {
  static override get [Symbol.species]() {
    return Array;
  }

  override filter(predicate: (value: TextValue, index: number, array: TextValue[]) => unknown): TextValueList {
    const out = new TextValueList();
    this.forEach((value, index, array) => {
      if (predicate(value, index, array)) out.push(value);
    });
    return out;
  }

  override slice(start?: number, end?: number): TextValueList {
    const out = new TextValueList();
    out.push(...Array.prototype.slice.call(this, start, end));
    return out;
  }

  /** Call `.re()` on each element and return the results flattened */
  re(regex: RegexInput, options: ReOptions = {}): TextValueList {
    const out = new TextValueList();
    for (const text of this) out.push(...text.re(regex, options));
    return out;
  }

  /** Call `.re()` on each element and return the first result or the default value */
  reFirst<D = null>(regex: RegexInput, defaultValue: D = null as D, options: ReOptions = {}): TextValue | D {
    for (const text of this) {
      const results = text.re(regex, options);
      if (results.length) return results[0]!;
    }
    return defaultValue;
  }

  /** Return the first item, or the default value when the list is empty */
  get<D = null>(defaultValue: D = null as D): TextValue | D {
    return this.length ? this[0]! : defaultValue;
  }

  getall(): TextValueList {
    return this;
  }

  extract(): TextValueList {
    return this;
  }

  extractFirst<D = null>(defaultValue: D = null as D): TextValue | D {
    return this.get(defaultValue);
  }

  /** The first item or `null` */
  get first(): TextValue | null {
    return this[0] ?? null;
  }

  /** The last item or `null` */
  get last(): TextValue | null {
    return this[this.length - 1] ?? null;
  }
}

/** A read-only mapping of an element's attributes with values as `TextValue`s */
export class AttributeMap implements Iterable<string> {
  private readonly data: ReadonlyMap<string, TextValue>;

  constructor(mapping: Record<string, unknown> | Iterable<[string, unknown]> | null = null) {
    const map = new Map<string, TextValue>();
    if (mapping) {
      const entries = Symbol.iterator in Object(mapping) ? (mapping as Iterable<[string, unknown]>) : Object.entries(mapping);
      for (const [key, value] of entries) map.set(key, value instanceof TextValue ? value : new TextValue(value));
    }
    this.data = map;
  }

  /** Acts like `Map.get()` with an optional default value */
  get<D = undefined>(key: string, defaultValue?: D): TextValue | D {
    return this.data.has(key) ? this.data.get(key)! : (defaultValue as D);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  keys(): IterableIterator<string> {
    return this.data.keys();
  }

  values(): IterableIterator<TextValue> {
    return this.data.values();
  }

  entries(): IterableIterator<[string, TextValue]> {
    return this.data.entries();
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.data.keys();
  }

  get size(): number {
    return this.data.size;
  }

  get length(): number {
    return this.data.size;
  }

  /** Search the attributes by value and yield a handler of each matching item */
  *searchValues(keyword: string, partial = false): Generator<AttributeMap> {
    for (const [key, value] of this.data) {
      const text = value.valueOf();
      if (partial ? text.includes(keyword) : text === keyword) yield new AttributeMap({ [key]: value });
    }
  }

  /** Convert the attributes to a plain object */
  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of this.data) out[key] = value.valueOf();
    return out;
  }

  /** The attributes as a JSON string */
  get jsonString(): string {
    return JSON.stringify(this.toObject());
  }

  toJSON(): Record<string, string> {
    return this.toObject();
  }

  toString(): string {
    return JSON.stringify(this.toObject());
  }
}
