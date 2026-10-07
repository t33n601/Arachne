/** A proxy as a URL string or a Playwright-style object */
export type ProxyType = string | { server: string; username?: string; password?: string };

export type RotationStrategy = (proxies: ProxyType[], currentIndex: number) => [ProxyType, number];

const PROXY_ERROR_INDICATORS = [
  "net::err_proxy",
  "net::err_tunnel",
  "connection refused",
  "connection reset",
  "connection timed out",
  "failed to connect",
  "could not resolve proxy",
  "proxy",
  "econnrefused",
  "econnreset",
];

function proxyKey(proxy: ProxyType): string {
  if (typeof proxy === "string") return proxy;
  return `${proxy.server ?? ""}|${proxy.username ?? ""}`;
}

/** Check if an error is proxy-related. Works for both HTTP and browser errors. */
export function isProxyError(error: unknown): boolean {
  const message = (error instanceof Error ? `${error.name} ${error.message}` : String(error)).toLowerCase();
  return PROXY_ERROR_INDICATORS.some((indicator) => message.includes(indicator));
}

/** The default strategy: iterate through proxies sequentially, wrapping around at the end */
export const cyclicRotation: RotationStrategy = (proxies, currentIndex) => {
  const idx = currentIndex % proxies.length;
  return [proxies[idx]!, (idx + 1) % proxies.length];
};

/** A proxy rotator with pluggable rotation strategies */
export class ProxyRotator {
  private readonly _proxies: ProxyType[] = [];
  private readonly proxyToIndex = new Map<string, number>();
  private currentIndex = 0;

  /**
   * @param proxies Proxy URLs (`"http://user:pass@proxy:8080"`) or Playwright-style objects (`{server, username, password}`)
   * @param strategy Takes `(proxies, currentIndex)` and returns `[proxy, nextIndex]`. Defaults to `cyclicRotation`.
   */
  constructor(
    proxies: ProxyType[],
    private readonly strategy: RotationStrategy = cyclicRotation,
  ) {
    if (!proxies || !proxies.length) throw new Error("At least one proxy must be provided");
    if (typeof strategy !== "function") throw new TypeError(`strategy must be callable, got ${typeof strategy}`);

    proxies.forEach((proxy, i) => {
      if (typeof proxy === "string" || (proxy && typeof proxy === "object")) {
        if (typeof proxy === "object" && !("server" in proxy)) throw new Error("Proxy object must have a 'server' key");
        this.proxyToIndex.set(proxyKey(proxy), i);
        this._proxies.push(proxy);
      } else {
        throw new TypeError(`Invalid proxy type: ${typeof proxy}. Expected string or object.`);
      }
    });
  }

  /** Get the next proxy according to the rotation strategy */
  getProxy(): ProxyType {
    const [proxy, next] = this.strategy(this._proxies, this.currentIndex);
    this.currentIndex = next;
    return proxy;
  }

  /** A copy of all configured proxies */
  get proxies(): ProxyType[] {
    return [...this._proxies];
  }

  get length(): number {
    return this._proxies.length;
  }

  toString(): string {
    return `ProxyRotator(proxies=${this._proxies.length})`;
  }
}
