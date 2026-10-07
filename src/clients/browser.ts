import { BaseClient, type Response } from "../transport/utils/response.js";
import { BrowserSession, AsyncBrowserSession } from "../transport/browsers/browser.js";
import type { PlaywrightFetchOptions, PlaywrightSessionOptions } from "../transport/browsers/config.js";

export { BrowserSession, AsyncBrowserSession };

/**
 * Fetch a page with a real browser (Playwright + Chromium) in one call: it launches the browser, opens the page,
 * waits as configured, returns the `Response`, and closes the browser.
 */
export class Browser extends BaseClient {
  static async fetch(url: string, options: PlaywrightSessionOptions & Pick<PlaywrightFetchOptions, "meta"> = {}): Promise<Response> {
    const { meta, ...sessionOptions } = options;
    if (sessionOptions.selectorConfig !== undefined && (typeof sessionOptions.selectorConfig !== "object" || sessionOptions.selectorConfig === null)) {
      throw new TypeError("Argument `selectorConfig` must be an object.");
    }
    sessionOptions.selectorConfig = this.generateParserArguments(sessionOptions.selectorConfig ?? {});
    const session = new BrowserSession(sessionOptions);
    await session.start();
    try {
      return await session.fetch(url, { meta });
    } finally {
      await session.close();
    }
  }
}
