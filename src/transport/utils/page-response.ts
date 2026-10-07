import type { Frame, Page, Response as PlaywrightResponse } from "playwright";

import { log } from "../../core/logger.js";
import { Response, StatusText, type BrowserCookie, type NodeConfig } from "./response.js";

const CHARSET_RE = /charset=["']?([\w-]+)/i;

function extractEncoding(contentType: string | undefined, fallback = "utf-8"): string {
  if (!contentType) return fallback;
  return CHARSET_RE.exec(contentType)?.[1] ?? fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds `Response` objects from browser responses */
export const ResponseFactory = {
  /**
   * `page.content()` can fail while the page is navigating (https://github.com/microsoft/playwright/issues/16108),
   * so it's retried for a while.
   */
  async getPageContent(page: Page | Frame, maxRetries = 20): Promise<string> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return (await page.content()) || "";
      } catch {
        await sleep(500);
      }
    }
    throw new Error(`Failed to retrieve the page content after retrying for ${maxRetries * 500}ms.`);
  },

  async processHistory(firstResponse: PlaywrightResponse, parserArguments: NodeConfig): Promise<Response[]> {
    const history: Response[] = [];
    let current = firstResponse.request().redirectedFrom();
    try {
      while (current) {
        try {
          const redirectResponse = await current.response();
          history.unshift(
            new Response({
              url: current.url(),
              // Redirect responses don't have a body available
              content: "",
              status: redirectResponse?.status() ?? 301,
              reason: redirectResponse
                ? redirectResponse.statusText() || StatusText.get(redirectResponse.status())
                : StatusText.get(301),
              encoding: redirectResponse ? extractEncoding(redirectResponse.headers()["content-type"]) : "utf-8",
              cookies: [],
              headers: redirectResponse ? await redirectResponse.allHeaders() : {},
              requestHeaders: await current.allHeaders(),
              ...parserArguments,
            }),
          );
        } catch (e) {
          log.error(`Error processing redirect: ${(e as Error).message}`);
          break;
        }
        current = current.redirectedFrom();
      }
    } catch (e) {
      log.error(`Error processing response history: ${(e as Error).message}`);
    }
    return history;
  },

  /**
   * Turn a Playwright response into our `Response`, with the page's final content, status, headers, cookies, redirect
   * history, and the captured XHR responses.
   */
  async fromPlaywrightResponse(
    page: Page | null,
    firstResponse: PlaywrightResponse,
    finalResponse: PlaywrightResponse | null,
    parserArguments: NodeConfig,
    options: { meta?: Record<string, unknown>; xhrCaptured?: PlaywrightResponse[]; collectHistory?: boolean } = {},
  ): Promise<Response> {
    const { meta, xhrCaptured, collectHistory = true } = options;
    // In case we didn't catch a document response somehow
    const final = finalResponse ?? firstResponse;
    if (!final) throw new Error("Failed to get a response from the page");

    let encoding = extractEncoding(final.headers()["content-type"]);
    // Playwright sometimes gives an empty status text
    const statusText = final.statusText() || StatusText.get(final.status());
    const history = collectHistory ? await ResponseFactory.processHistory(firstResponse, parserArguments) : [];

    let content: Uint8Array;
    try {
      const contentType = (await final.allHeaders())["content-type"] ?? "";
      if (page && contentType.includes("html")) {
        content = new TextEncoder().encode(await ResponseFactory.getPageContent(page));
        encoding = "utf-8";
      } else {
        content = new Uint8Array(await final.body());
      }
    } catch (e) {
      log.error(`Error getting page content: ${(e as Error).message}`);
      content = new Uint8Array();
    }

    const response = new Response({
      url: page ? page.url() : firstResponse.url(),
      content,
      status: final.status(),
      reason: statusText,
      encoding,
      cookies: page ? ((await page.context().cookies()) as BrowserCookie[]) : {},
      headers: await firstResponse.allHeaders(),
      requestHeaders: await firstResponse.request().allHeaders(),
      method: firstResponse.request().method(),
      history,
      meta,
      ...parserArguments,
    });

    if (xhrCaptured?.length) {
      const captured: Response[] = [];
      for (const xhr of xhrCaptured) {
        try {
          captured.push(await ResponseFactory.fromPlaywrightResponse(null, xhr, null, {}, { collectHistory: false }));
        } catch (e) {
          log.debug(`Failed to convert a captured XHR response: ${(e as Error).message}`);
        }
      }
      response.capturedXhr = captured;
    }
    return response;
  },
};
