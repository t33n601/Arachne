/** URL helpers ported from the w3lib functions the crawlers rely on */

/** Characters HTML5 considers whitespace, stripped around URL attributes */
const HTML5_WHITESPACE = " \t\n\r\f";

export function stripHtml5Whitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && HTML5_WHITESPACE.includes(text[start]!)) start++;
  while (end > start && HTML5_WHITESPACE.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
}

function encodeQueryPart(value: string): string {
  // Same as Python's `quote_plus` with w3lib's safe characters
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":")
    .replace(/%40/gi, "@")
    .replace(/%2C/gi, ",")
    .replace(/%3B/gi, ";")
    .replace(/%24/gi, "$")
    .replace(/%7E/gi, "~");
}

function decodeQueryPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Canonicalize a URL for comparison: lowercase scheme/host, sorted query arguments, normalized percent-encoding, and
 * no fragment (unless `keepFragments`). Like w3lib's `canonicalize_url`.
 */
export function canonicalizeUrl(url: string, keepFragments = false): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const query = parsed.search.replace(/^\?/, "");
  if (query) {
    const pairs = query
      .split("&")
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf("=");
        const key = idx === -1 ? pair : pair.slice(0, idx);
        const value = idx === -1 ? "" : pair.slice(idx + 1);
        return [decodeQueryPart(key), decodeQueryPart(value)] as [string, string];
      });
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    parsed.search = pairs.map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(value)}`).join("&");
  }
  if (!keepFragments) parsed.hash = "";

  // Normalize the percent-encoding of the path (uppercase escapes, decode unreserved characters)
  parsed.pathname = parsed.pathname.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(char) ? char : `%${hex.toUpperCase()}`;
  });

  let result = parsed.href;
  // `URL` keeps a trailing `?` for empty queries in some cases
  if (!parsed.search) result = result.replace(/\?(?=#|$)/, "");
  return result;
}

/** Make a URL safe to request: percent-encode what's not allowed, like w3lib's `safe_url_string` */
export function safeUrlString(url: string): string {
  const parsed = new URL(url);
  return parsed.href;
}

/** Remove HTML tags from a string, like w3lib's `remove_tags` */
export function removeTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}
