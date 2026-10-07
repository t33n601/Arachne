import { log } from "../core/logger.js";

export const BLOCK_BACKOFF_FACTOR = 2.0;

/** How many seconds a `Retry-After` header asks to wait, or `null` when it's missing or unreadable */
export function parseRetryAfter(headers: Record<string, string>): number | null {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === "retry-after");
  const value = (key ? headers[key] : "")?.trim() ?? "";
  if (!value) return null;

  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return Math.max(Number(value), 0);

  // The header can be an HTTP date instead of a number of seconds
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max((date - Date.now()) / 1000, 0);

  log.debug(`Ignoring an unreadable \`Retry-After\` header: ${JSON.stringify(value)}`);
  return null;
}

/**
 * Adjusts the per-domain delay from the observed response latency, so the crawler speeds up on fast servers and backs
 * off on slow or hostile ones.
 */
export class AutoThrottle {
  readonly delays = new Map<string, number>();

  /**
   * @param startDelay The delay used for the first request to a domain
   * @param maxDelay The highest delay the throttle is allowed to reach
   * @param targetConcurrency How many requests the crawler aims to have in flight per domain
   * @param blockBackoff Double the delay of a domain whenever it blocks us, or wait what its `Retry-After` asks for
   */
  constructor(
    readonly startDelay = 5.0,
    readonly maxDelay = 60.0,
    readonly targetConcurrency = 1.0,
    readonly blockBackoff = true,
  ) {
    if (targetConcurrency <= 0) throw new Error("`targetConcurrency` must be higher than 0");
    if (maxDelay < startDelay) throw new Error("`autothrottleMaxDelay` can't be lower than `autothrottleStartDelay`");
  }

  /** The current delay for a domain, starting at `startDelay` the first time */
  delayFor(domain: string, floor = 0): number {
    if (!this.delays.has(domain)) this.delays.set(domain, Math.min(Math.max(floor, this.startDelay), this.maxDelay));
    return this.delays.get(domain)!;
  }

  /** Feed a finished request back into the throttle and return the domain's new delay */
  record(domain: string, latency: number, ok: boolean, floor = 0, retryAfter: number | null = null): number {
    const currentDelay = this.delayFor(domain, floor);
    const targetDelay = latency / this.targetConcurrency;
    let newDelay = Math.max((currentDelay + targetDelay) / 2, targetDelay);

    if (!ok) {
      let penalty = currentDelay;
      if (this.blockBackoff) penalty = retryAfter !== null ? retryAfter : currentDelay * BLOCK_BACKOFF_FACTOR;
      newDelay = Math.max(newDelay, penalty, currentDelay); // A block can never speed the crawler up
    }

    newDelay = Math.min(Math.max(newDelay, floor), this.maxDelay);
    this.delays.set(domain, newDelay);
    log.debug(
      `AutoThrottle (${domain}): latency=${latency.toFixed(2)}s, ok=${ok}, delay ${currentDelay.toFixed(2)}s -> ${newDelay.toFixed(2)}s`,
    );
    return newDelay;
  }

  /** Drop every learned delay */
  reset(): void {
    this.delays.clear();
  }
}
