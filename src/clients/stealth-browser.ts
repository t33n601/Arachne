import { BaseClient, type Response } from "../transport/utils/response.js";
import { StealthBrowserSession, AsyncStealthBrowserSession } from "../transport/browsers/stealth.js";
import type { PlaywrightFetchOptions, StealthSessionOptions } from "../transport/browsers/config.js";

export { StealthBrowserSession, AsyncStealthBrowserSession };

/**
 * Fetch a page with a stealth browser (Patchright + Chromium with anti-detection settings) in one call. It passes
 * most online bot tests and can solve Cloudflare challenges with `solveCloudflare: true`.
 */
export class StealthBrowser extends BaseClient {
  static async fetch(url: string, options: StealthSessionOptions & Pick<PlaywrightFetchOptions, "meta"> = {}): Promise<Response> {
    const { meta, ...sessionOptions } = options;
    if (sessionOptions.selectorConfig !== undefined && (typeof sessionOptions.selectorConfig !== "object" || sessionOptions.selectorConfig === null)) {
      throw new TypeError("Argument `selectorConfig` must be an object.");
    }
    sessionOptions.selectorConfig = this.generateParserArguments(sessionOptions.selectorConfig ?? {});
    const session = new StealthBrowserSession(sessionOptions);
    await session.start();
    try {
      return await session.fetch(url, { meta });
    } finally {
      await session.close();
    }
  }
}
