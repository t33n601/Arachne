import type { BrowserType } from "playwright";

import { BaseBrowserSession } from "./base.js";
import type { PlaywrightSessionOptions } from "./config.js";

/**
 * A browser session (Playwright + Chromium) with a pool of tabs. It uses a persistent context with a temporary profile
 * by default.
 *
 * ```ts
 * await using session = await new BrowserSession({ headless: true, maxPages: 3 }).start();
 * const page = await session.fetch("https://example.com", { networkIdle: true });
 * ```
 */
export class BrowserSession extends BaseBrowserSession {
  constructor(options: PlaywrightSessionOptions = {}) {
    super(options, false);
    this.generateOptions();
  }

  protected async browserType(): Promise<BrowserType> {
    const { chromium } = await import("playwright");
    return chromium;
  }
}

/** Everything is asynchronous in JavaScript, so this is the same as `BrowserSession` (kept for API familiarity) */
export const AsyncBrowserSession = BrowserSession;
