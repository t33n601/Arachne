import { log } from "../core/logger.js";
import type { CheckpointData } from "./checkpoint.js";
import type { Request } from "./request.js";

type Item = [negPriority: number, counter: number, request: Request];

function less(a: Item, b: Item): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** A binary min-heap */
class Heap {
  private readonly items: Item[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: Item): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): Item | undefined {
    const items = this.items;
    if (!items.length) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && less(items[l]!, items[smallest]!)) smallest = l;
        if (r < items.length && less(items[r]!, items[smallest]!)) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

/** Priority queue with URL deduplication. Higher priority requests are processed first. */
export class Scheduler {
  private readonly queue = new Heap();
  private seen = new Set<string>();
  private counter = 0;
  // Mirror of the queue for checkpoint snapshots without draining it
  private readonly pending = new Map<number, Item>();
  private readonly inflight = new Map<Request, number[]>();

  constructor(
    private readonly includeKwargs = false,
    private readonly includeHeaders = false,
    private readonly keepFragments = false,
  ) {}

  /** Add a request to the queue, returns `false` when it's a filtered duplicate */
  enqueue(request: Request): boolean {
    const fingerprint = request.updateFingerprint(this.includeKwargs, this.includeHeaders, this.keepFragments);
    if (!request.dontFilter && this.seen.has(fingerprint)) {
      log.debug(`Dropped duplicate request: ${request.url}`);
      return false;
    }
    this.seen.add(fingerprint);
    const counter = this.counter++;
    const item: Item = [-request.priority, counter, request];
    this.pending.set(counter, item);
    this.queue.push(item);
    return true;
  }

  /** Get the next request to process (it stays tracked until `complete()`) */
  dequeue(): Request | undefined {
    const item = this.queue.pop();
    if (!item) return undefined;
    const [, counter, request] = item;
    const counters = this.inflight.get(request);
    if (counters) counters.push(counter);
    else this.inflight.set(request, [counter]);
    return request;
  }

  /** Mark a request as finished so it stops being tracked for checkpoints */
  complete(request: Request): void {
    const counters = this.inflight.get(request);
    if (!counters?.length) return;
    const counter = counters.pop()!;
    if (!counters.length) this.inflight.delete(request);
    this.pending.delete(counter);
  }

  get length(): number {
    return this.queue.size;
  }

  get isEmpty(): boolean {
    return this.queue.size === 0;
  }

  /** Snapshot the current state for checkpoints, in queue order */
  snapshot(): { requests: Request[]; seen: Set<string> } {
    const items = [...this.pending.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return { requests: items.map((item) => item[2]), seen: new Set(this.seen) };
  }

  /** Restore the state from checkpoint data */
  restore(data: CheckpointData): void {
    this.seen = new Set(data.seen);
    for (const request of data.requests) {
      const counter = this.counter++;
      const item: Item = [-request.priority, counter, request];
      this.pending.set(counter, item);
      this.queue.push(item);
    }
    log.info(`Scheduler restored: ${data.requests.length} requests, ${data.seen.size} seen`);
  }
}
