import type { BrowserType, Page } from "playwright";

import { log } from "../../core/logger.js";
import { Node } from "../../parser.js";
import { DEFAULT_ARGS, STEALTH_ARGS } from "../constants.js";
import { ResponseFactory } from "../utils/page-response.js";
import { BaseBrowserSession } from "./base.js";
import type { FetchParams, StealthSessionOptions } from "./config.js";

const CF_PATTERN = /^https?:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\/.*/;
const CF_MAX_SOLVE_ATTEMPTS = 3;

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Detect the type of Cloudflare challenge present in the page content, if any */
export function detectCloudflare(pageContent: string): "non-interactive" | "managed" | "interactive" | "embedded" | null {
  for (const type of ["non-interactive", "managed", "interactive"] as const) {
    if (pageContent.includes(`cType: '${type}'`)) return type;
  }
  // A turnstile captcha embedded inside the page (usually inside a closed shadow iframe)
  if (new Node(pageContent).css('script[src*="challenges.cloudflare.com/turnstile/v"]').length) return "embedded";
  return null;
}

/** Whether the Cloudflare challenge is no longer present in the page content */
export function challengeCleared(pageContent: string, challengeType: string): boolean {
  return challengeType === "embedded" || detectCloudflare(pageContent) === null;
}

/**
 * A stealth browser session (Patchright + Chromium with anti-detection patches and flags) with a pool of tabs. It
 * passes most online bot tests and can solve Cloudflare's Turnstile/Interstitial challenges.
 *
 * ```ts
 * await using session = await new StealthBrowserSession({ solveCloudflare: true }).start();
 * const page = await session.fetch("https://nopecha.com/demo/cloudflare");
 * ```
 */
export class StealthBrowserSession extends BaseBrowserSession {
  constructor(options: StealthSessionOptions = {}) {
    super(options, true);
    Object.assign(this.contextOptions, {
      isMobile: false,
      hasTouch: false,
      serviceWorkers: "allow",
      ignoreHTTPSErrors: true,
      screen: { width: 1920, height: 1080 },
      viewport: { width: 1920, height: 1080 },
      permissions: ["geolocation", "notifications"],
    });

    const flags: string[] = [];
    if (!this.config.cdpUrl) {
      flags.push(...DEFAULT_ARGS, ...STEALTH_ARGS);
      if (this.config.blockWebrtc) {
        flags.push("--webrtc-ip-handling-policy=disable_non_proxied_udp", "--force-webrtc-ip-handling-policy");
      }
      if (!this.config.allowWebgl) flags.push("--disable-webgl", "--disable-webgl-image-chromium", "--disable-webgl2");
      if (this.config.hideCanvas) flags.push("--fingerprinting-canvas-image-data-noise");
    }
    this.generateOptions(flags);
  }

  protected override isStealth(): boolean {
    return true;
  }

  protected async browserType(): Promise<BrowserType> {
    try {
      const { chromium } = (await import("patchright")) as unknown as { chromium: BrowserType };
      return chromium;
    } catch {
      log.warning("`patchright` isn't installed, falling back to `playwright` (weaker anti-detection)");
      const { chromium } = await import("playwright");
      return chromium;
    }
  }

  protected override async afterNavigation(page: Page, params: FetchParams): Promise<void> {
    if (!params.solveCloudflare) return;
    await this.cloudflareSolver(page);
    // Make sure the page is fully loaded after the captcha
    await this.waitForPageStability(page, params.loadDom, params.networkIdle);
  }

  /** Solve the Cloudflare challenge displayed on the page */
  async cloudflareSolver(page: Page, attempts = 0): Promise<void> {
    await this.waitForNetworkIdle(page, 5000);
    const content = () => ResponseFactory.getPageContent(page);
    const challengeType = detectCloudflare(await content());
    if (!challengeType) {
      log.error("No Cloudflare challenge found.");
      return;
    }
    if (attempts >= CF_MAX_SOLVE_ATTEMPTS) {
      log.error(`Failed to solve the Cloudflare challenge after ${attempts} attempts, returning the page as is`);
      return;
    }
    log.info(`The turnstile version discovered is "${challengeType}"`);

    if (challengeType === "non-interactive") {
      while (detectCloudflare(await content()) === "non-interactive") {
        log.info("Waiting for Cloudflare wait page to disappear.");
        await page.waitForTimeout(1000);
        await page.waitForLoadState();
      }
      if (challengeCleared(await content(), challengeType)) {
        log.info("Cloudflare captcha is solved");
        return;
      }
      return this.cloudflareSolver(page, attempts + 1);
    }

    let boxSelector = "#cf_turnstile div, #cf-turnstile div, .turnstile>div>div";
    const findFrame = () => page.frames().find((frame) => CF_PATTERN.test(frame.url())) ?? null;
    if (challengeType !== "embedded") {
      boxSelector = ".main-content p+div>div>div";
      for (let i = 0; i < 20; i++) {
        // Waiting for the verify spinner to resolve into the widget iframe or pass on its own
        if (findFrame() || challengeCleared(await content(), challengeType)) break;
        await page.waitForTimeout(500);
      }
    }

    let outerBox: { x: number; y: number } | null = null;
    const iframe = findFrame();
    if (iframe) {
      await this.waitForPageStability(iframe, true, false);
      const element = await iframe.frameElement();
      if (challengeType !== "embedded") {
        // Double-checking that the iframe is loaded
        while (!(await element.isVisible())) await page.waitForTimeout(500);
      }
      outerBox = await element.boundingBox();
    }

    if (!iframe || !outerBox) {
      if (challengeCleared(await content(), challengeType)) {
        log.info("Cloudflare captcha is solved");
        return;
      }
      outerBox = await page.locator(boxSelector).last().boundingBox();
      if (!outerBox) {
        await page.waitForTimeout(1000);
        return this.cloudflareSolver(page, attempts + 1);
      }
    }

    // Calculate the captcha coordinates for any viewport
    const x = outerBox.x + randInt(26, 28);
    const y = outerBox.y + randInt(25, 27);
    await page.mouse.click(x, y, { delay: randInt(100, 200), button: "left" });
    await this.waitForNetworkIdle(page);

    if (challengeType !== "embedded") {
      let waited = 0;
      while (!challengeCleared(await content(), challengeType)) {
        if (waited >= 100) {
          log.info("Cloudflare page didn't disappear after 10s, continuing...");
          break;
        }
        await page.waitForTimeout(100);
        waited++;
      }
    }

    await this.waitForPageStability(page, true, false);
    if (challengeCleared(await content(), challengeType)) {
      log.info("Cloudflare captcha is solved");
      return;
    }
    log.info("Looks like Cloudflare captcha is still present, solving again");
    return this.cloudflareSolver(page, attempts + 1);
  }
}

/** Everything is asynchronous in JavaScript, so this is the same as `StealthBrowserSession` (kept for API familiarity) */
export const AsyncStealthBrowserSession = StealthBrowserSession;
