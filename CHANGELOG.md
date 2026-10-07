# Changelog

## 0.1.0

First release.

- HTML parser with CSS selectors (`::text`, `::attr()`), XPath 1.0, text/regex search, `findAll` filters, `findSimilar`, navigation, and selector generation.
- Element tracking: elements are relocated by similarity after website changes (SQLite storage).
- `Http` / `HttpSession`: HTTP with real browser TLS fingerprints, browser headers, cookies, retries, proxy rotation, and SSRF-safe redirects.
- `Browser` / `BrowserSession` and `StealthBrowser` / `StealthBrowserSession`: Playwright browsers with tab pooling, ad blocking, XHR capture, and Cloudflare solving.
- Crawler framework with scheduling, concurrency limits, AutoThrottle, robots.txt, checkpoints, development cache, streaming, and exports.
- Crawler templates: `LinkCrawler`, `SitemapCrawler`, `XmlFeedCrawler`, `CsvFeedCrawler`, `ShopifyCrawler`, `MarkdownCrawler`.
- `arachne` CLI, interactive shell, and MCP server.
