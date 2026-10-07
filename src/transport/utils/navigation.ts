/** Helpers related to URLs, proxies, and browser requests interception */
import type { Route } from "playwright";

import { log } from "../../core/logger.js";
import { EXTRA_RESOURCES } from "../constants.js";
import type { ProxyType } from "./proxy-rotation.js";

export interface PlaywrightProxy {
  server: string;
  username: string;
  password: string;
}

/**
 * Check if a hostname or any of its parent domains is blocked, e.g. for "tracker.ads.doubleclick.net" it checks
 * "tracker.ads.doubleclick.net", "ads.doubleclick.net", and "doubleclick.net".
 */
export function isDomainBlocked(hostname: string, domains: ReadonlySet<string>): boolean {
  if (domains.has(hostname)) return true;
  let idx = hostname.indexOf(".");
  while (idx !== -1) {
    const suffix = hostname.slice(idx + 1);
    if (suffix.includes(".") && domains.has(suffix)) return true;
    idx = hostname.indexOf(".", idx + 1);
  }
  return false;
}

/** Build a route handler that blocks resource types and/or specific domains */
export function createInterceptHandler(
  disableResources: boolean,
  blockedDomains?: Iterable<string> | null,
): (route: Route) => Promise<void> {
  const disabled = disableResources ? EXTRA_RESOURCES : new Set<string>();
  const domains = new Set(blockedDomains ?? []);

  return async (route: Route) => {
    const request = route.request();
    const type = request.resourceType();
    try {
      if (disabled.has(type)) {
        log.debug(`Blocking background resource "${request.url()}" of type "${type}"`);
        await route.abort();
        return;
      }
      if (domains.size) {
        let hostname = "";
        try {
          hostname = new URL(request.url()).hostname;
        } catch {
          // Not a URL we can parse (data:, blob:...), let it through
        }
        if (hostname && isDomainBlocked(hostname, domains)) {
          log.debug(`Blocking request to blocked domain "${hostname}" (${request.url()})`);
          await route.abort();
          return;
        }
      }
      await route.continue();
    } catch {
      // The page/route might be closed already
    }
  };
}

/** Validate a proxy and return it in the format Playwright accepts */
export function constructProxyDict(proxy: ProxyType | readonly [string, string?, string?]): PlaywrightProxy {
  if (typeof proxy === "string") {
    let parsed: URL;
    try {
      parsed = new URL(proxy);
    } catch {
      throw new Error("Invalid proxy string!");
    }
    const scheme = parsed.protocol.replace(":", "");
    if (!["http", "https", "socks4", "socks5"].includes(scheme) || !parsed.hostname) throw new Error("Invalid proxy string!");
    let server = `${scheme}://${parsed.hostname}`;
    if (parsed.port) server += `:${parsed.port}`;
    return {
      server,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }
  if (Array.isArray(proxy)) {
    const [server, username = "", password = ""] = proxy as readonly [string, string?, string?];
    return { server, username, password };
  }
  if (proxy && typeof proxy === "object") {
    const dict = proxy as { server?: unknown; username?: unknown; password?: unknown };
    if (typeof dict.server !== "string") throw new TypeError("Invalid proxy dictionary: `server` must be a string");
    for (const key of Object.keys(dict)) {
      if (!["server", "username", "password"].includes(key)) {
        throw new TypeError(`Invalid proxy dictionary: unexpected key \`${key}\``);
      }
    }
    if (dict.username !== undefined && typeof dict.username !== "string") throw new TypeError("Invalid proxy dictionary: `username` must be a string");
    if (dict.password !== undefined && typeof dict.password !== "string") throw new TypeError("Invalid proxy dictionary: `password` must be a string");
    return { server: dict.server, username: (dict.username as string) ?? "", password: (dict.password as string) ?? "" };
  }
  throw new TypeError(`Invalid proxy string: ${String(proxy)}`);
}

/** Turn any proxy format into a URL string usable by the HTTP client */
export function proxyToUrl(proxy: ProxyType): string {
  if (typeof proxy === "string") return proxy;
  const url = new URL(proxy.server.includes("://") ? proxy.server : `http://${proxy.server}`);
  if (proxy.username) url.username = encodeURIComponent(proxy.username);
  if (proxy.password) url.password = encodeURIComponent(proxy.password);
  return url.href.replace(/\/$/, "");
}
