/** Generating real browser headers and fingerprint related helpers */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { HeaderGenerator, type HeaderGeneratorOptions } from "header-generator";

type OSName = "linux" | "macos" | "windows" | "android" | "ios";
const DESKTOP_OS: OSName[] = ["linux", "macos", "windows"];
const MINIMUM_CHROME_VERSION = 140;

let osNameCache: OSName | null = null;

/** The current OS name in the format the header generator needs */
export function getOsName(): OSName {
  if (osNameCache) return osNameCache;
  switch (process.platform) {
    case "darwin":
      osNameCache = "macos";
      break;
    case "win32":
      osNameCache = "windows";
      break;
    case "android":
      osNameCache = "android";
      break;
    default:
      osNameCache = "linux";
  }
  return osNameCache;
}

const drivenVersions = new Map<string, number | null>();

/** The Chromium major version the installed automation package drives, read from its bundled `browsers.json` */
export function drivenBrowserVersion(pkg: "playwright" | "patchright" = "playwright"): number | null {
  if (drivenVersions.has(pkg)) return drivenVersions.get(pkg)!;
  let version: number | null = null;
  try {
    const require = createRequire(import.meta.url);
    const corePkg = pkg === "playwright" ? "playwright-core" : "patchright-core";
    const root = dirname(require.resolve(`${corePkg}/package.json`));
    const browsers = JSON.parse(readFileSync(join(root, "browsers.json"), "utf-8")).browsers as {
      name: string;
      browserVersion?: string;
    }[];
    const chromium = browsers.find((entry) => entry.name === "chromium");
    if (chromium?.browserVersion) version = Number.parseInt(chromium.browserVersion.split(".")[0]!, 10) || null;
  } catch {
    version = null;
  }
  drivenVersions.set(pkg, version);
  return version;
}

/**
 * Generate real browser-like headers.
 *
 * @param browserMode When enabled, the headers are meant for a Chromium browser, so it has to match it exactly
 */
export function generateHeaders(browserMode = false): Record<string, string> {
  const osName = getOsName();
  const isDesktop = DESKTOP_OS.includes(osName);
  const options: Partial<HeaderGeneratorOptions> = {
    browsers: browserMode
      ? [{ name: "chrome", minVersion: MINIMUM_CHROME_VERSION }]
      : [
          { name: "chrome", minVersion: MINIMUM_CHROME_VERSION },
          { name: "firefox", minVersion: 140 },
          { name: "edge", minVersion: 140 },
        ],
    operatingSystems: browserMode || !isDesktop ? [osName] : DESKTOP_OS,
    devices: [isDesktop ? "desktop" : "mobile"],
    locales: ["en-US", "en"],
    strict: false,
  };

  let headers: Record<string, string>;
  try {
    headers = new HeaderGenerator(options).getHeaders() as Record<string, string>;
  } catch {
    headers = new HeaderGenerator({ ...options, browsers: browserMode ? ["chrome"] : ["chrome", "firefox", "edge"] }).getHeaders() as Record<
      string,
      string
    >;
  }

  if (browserMode) {
    const driven = drivenBrowserVersion() ?? drivenBrowserVersion("patchright");
    if (driven && headers["user-agent"]) {
      headers["user-agent"] = headers["user-agent"].replace(/Chrome\/[\d.]+/, `Chrome/${driven}.0.0.0`);
    }
  }
  return headers;
}

let defaultUserAgent: string | undefined;
let defaultBrowserUserAgent: string | undefined;

/** A real useragent for plain HTTP requests (generated once) */
export function getDefaultUserAgent(): string {
  defaultUserAgent ??= generateHeaders(false)["user-agent"]!;
  return defaultUserAgent;
}

/** A real Chrome useragent that matches the driven Chromium version (generated once) */
export function getDefaultBrowserUserAgent(): string {
  defaultBrowserUserAgent ??= generateHeaders(true)["user-agent"]!;
  return defaultBrowserUserAgent;
}
