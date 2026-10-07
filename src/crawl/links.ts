/** URL discovery primitive */
import { log } from "../core/logger.js";
import type { Response } from "../transport/utils/response.js";
import type { Node } from "../parser.js";
import { canonicalizeUrl, safeUrlString, stripHtml5Whitespace } from "./url-utils.js";

const VALID_SCHEMES = new Set(["http", "https", "file"]);

export const IGNORED_EXTENSIONS: ReadonlySet<string> = new Set([
  // archives
  "7z", "7zip", "bz2", "rar", "tar", "tar.gz", "xz", "zip",
  // images
  "mng", "pct", "bmp", "gif", "jpg", "jpeg", "png", "pst", "psp", "tif", "tiff", "ai", "drw", "dxf", "eps", "ps", "svg",
  "cdr", "ico", "webp",
  // audio
  "mp3", "wma", "ogg", "wav", "ra", "aac", "mid", "au", "aiff",
  // video
  "3gp", "asf", "asx", "avi", "mov", "mp4", "mpg", "qt", "rm", "swf", "wmv", "m4a", "m4v", "flv", "webm",
  // office suites
  "xls", "xlsm", "xlsx", "xltm", "xltx", "potm", "potx", "ppt", "pptm", "pptx", "pps", "doc", "docb", "docm", "docx",
  "dotm", "dotx", "odt", "ods", "odg", "odp",
  // other
  "css", "pdf", "exe", "bin", "rss", "dmg", "iso", "apk", "jar", "sh", "rb", "js", "hta", "bat", "cpl", "msi", "msp",
  "py",
]);

type PatternInput = string | RegExp | Iterable<string | RegExp>;
type StrOrIterable = string | Iterable<string>;

function toArray(value: StrOrIterable | undefined | null): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  return [...value];
}

function compilePatterns(patterns: PatternInput | undefined | null): RegExp[] {
  if (!patterns) return [];
  if (typeof patterns === "string" || patterns instanceof RegExp) patterns = [patterns];
  return [...patterns].map((pattern) => (pattern instanceof RegExp ? pattern : new RegExp(pattern)));
}

function urlExtensions(url: string): string[] {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0]!;
  }
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!last.includes(".")) return [];
  const parts = last.toLowerCase().split(".");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) if (parts[i]) out.push(parts.slice(i).join("."));
  return out;
}

export interface LinkExtractorOptions {
  /** Regex pattern(s) URLs must match to be kept, empty means match all */
  allow?: PatternInput;
  /** Regex pattern(s) URLs must NOT match, takes precedence over `allow` */
  deny?: PatternInput;
  /** Domain(s) to keep, subdomains included */
  allowDomains?: StrOrIterable;
  /** Domain(s) to exclude, subdomains included */
  denyDomains?: StrOrIterable;
  /** CSS selectors to scope the extraction to, empty means the whole page */
  restrictCss?: StrOrIterable;
  /** XPath selectors to scope the extraction to, empty means the whole page */
  restrictXpath?: StrOrIterable;
  /** Element tags to look for links in (default: `a`, `area`) */
  tags?: Iterable<string>;
  /** Attributes to read URLs from (default: `href`) */
  attrs?: Iterable<string>;
  /** Canonicalize URLs (default: true) */
  canonicalize?: boolean;
  /** Strip whitespace around extracted URLs (default: true) */
  strip?: boolean;
  /** Keep URL fragments while canonicalizing (default: false) */
  keepFragment?: boolean;
  /** File extensions to drop (default: `IGNORED_EXTENSIONS`) */
  denyExtensions?: Iterable<string> | null;
  /** Process each extracted value, return a falsy value to drop it */
  process?: ((url: string) => string | null | undefined | false) | null;
}

/** Extracts and filters URLs from a `Response` (or checks a single URL with `matches()`) */
export class LinkExtractor {
  readonly allow: RegExp[];
  readonly deny: RegExp[];
  readonly allowDomains: string[];
  readonly denyDomains: string[];
  readonly restrictCss: string[];
  readonly restrictXpath: string[];
  readonly tags: string[];
  readonly attrs: string[];
  readonly canonicalize: boolean;
  readonly strip: boolean;
  readonly keepFragment: boolean;
  readonly denyExtensions: Set<string>;
  readonly process: (url: string) => string | null | undefined | false;

  constructor(options: LinkExtractorOptions = {}) {
    this.allow = compilePatterns(options.allow);
    this.deny = compilePatterns(options.deny);
    this.allowDomains = toArray(options.allowDomains).map((domain) => domain.toLowerCase());
    this.denyDomains = toArray(options.denyDomains).map((domain) => domain.toLowerCase());
    this.restrictCss = toArray(options.restrictCss);
    this.restrictXpath = toArray(options.restrictXpath);
    this.tags = [...(options.tags ?? ["a", "area"])];
    this.attrs = [...(options.attrs ?? ["href"])];
    this.canonicalize = options.canonicalize ?? true;
    this.strip = options.strip ?? true;
    this.keepFragment = options.keepFragment ?? false;
    this.denyExtensions = new Set(
      options.denyExtensions ? [...options.denyExtensions].map((ext) => ext.toLowerCase().replace(/^\.+/, "")) : IGNORED_EXTENSIONS,
    );
    this.process = typeof options.process === "function" ? options.process : (url) => url;
  }

  /** Absolute, filtered, deduplicated URLs from the response */
  extract(response: Response): string[] {
    const scopes: Node[] = [];
    for (const xp of this.restrictXpath) scopes.push(...response.xpath(xp));
    for (const css of this.restrictCss) scopes.push(...response.css(css));
    if (!scopes.length) scopes.push(response);

    const out: string[] = [];
    const searchSelector = this.tags.flatMap((tag) => this.attrs.map((attr) => `.//${tag}/@${attr}`)).join(" | ");
    for (const scope of scopes) {
      for (const node of scope.xpath(searchSelector)) {
        let url = node.text.valueOf();
        if (!url) continue;
        if (this.strip) {
          url = stripHtml5Whitespace(url);
          if (!url) continue;
        }
        const processed = this.process(response.urljoin(url));
        if (!processed) continue;
        url = processed;
        if (this.canonicalize) url = canonicalizeUrl(url, this.keepFragment);
        try {
          url = safeUrlString(url);
        } catch {
          log.debug(`Skipping the extraction of bad URL ${JSON.stringify(url)}`);
          continue;
        }
        if (this.urlPasses(url)) out.push(url);
      }
    }
    // Deduplicate while keeping the order
    return [...new Set(out)];
  }

  /** Apply the filters to a single URL, without a response */
  matches(url: string): boolean {
    if (this.canonicalize) url = canonicalizeUrl(url, this.keepFragment);
    return this.urlPasses(url);
  }

  private urlPasses(url: string): boolean {
    if (!VALID_SCHEMES.has(url.split("://", 1)[0]!)) return false;
    if (this.denyExtensions.size && urlExtensions(url).some((ext) => this.denyExtensions.has(ext))) return false;
    if (this.allow.length && !this.allow.some((pattern) => searchRegex(pattern, url))) return false;
    if (this.deny.length && this.deny.some((pattern) => searchRegex(pattern, url))) return false;
    if (this.allowDomains.length || this.denyDomains.length) {
      let host = "";
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return false;
      }
      if (this.allowDomains.length && !this.allowDomains.some((d) => host === d || host.endsWith(`.${d}`))) return false;
      if (this.denyDomains.length && this.denyDomains.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    }
    return true;
  }
}

function searchRegex(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(text);
  pattern.lastIndex = 0;
  return found;
}
