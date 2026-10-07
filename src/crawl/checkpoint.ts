import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../core/logger.js";
import { Request } from "./request.js";

/** Container for the checkpoint state */
export interface CheckpointData {
  requests: Request[];
  seen: Set<string>;
}

/**
 * Saves and loads the crawl state (pending requests + seen fingerprints) as JSON. Callbacks are stored by name and
 * restored from the crawler, so pass crawler methods as callbacks for resumable crawls.
 */
export class CheckpointManager {
  static readonly CHECKPOINT_FILE = "checkpoint.json";
  private readonly checkpointPath: string;

  constructor(
    readonly crawldir: string,
    readonly interval = 300.0,
  ) {
    if (typeof interval !== "number" || Number.isNaN(interval)) throw new TypeError("Checkpoints interval must be a number.");
    if (interval < 0) throw new Error("Checkpoints interval must be equal or greater than 0.");
    this.checkpointPath = join(crawldir, CheckpointManager.CHECKPOINT_FILE);
  }

  async hasCheckpoint(): Promise<boolean> {
    try {
      return (await stat(this.checkpointPath)).isFile();
    } catch {
      return false;
    }
  }

  /** Save the checkpoint atomically */
  async save(data: CheckpointData): Promise<void> {
    await mkdir(this.crawldir, { recursive: true });
    const temp = `${this.checkpointPath}.tmp`;
    try {
      const serialized = JSON.stringify({ requests: data.requests.map((request) => request.toJSON()), seen: [...data.seen] });
      await writeFile(temp, serialized);
      await rename(temp, this.checkpointPath);
      log.info(`Checkpoint saved: ${data.requests.length} requests, ${data.seen.size} seen URLs`);
    } catch (e) {
      await rm(temp, { force: true });
      log.error(`Failed to save checkpoint: ${(e as Error).message}`);
      throw e;
    }
  }

  /** Load the checkpoint, `null` if there's none or it can't be read */
  async load(): Promise<CheckpointData | null> {
    if (!(await this.hasCheckpoint())) return null;
    try {
      const raw = JSON.parse(await readFile(this.checkpointPath, "utf-8")) as { requests: Record<string, unknown>[]; seen: string[] };
      const data: CheckpointData = { requests: raw.requests.map((item) => Request.fromJSON(item)), seen: new Set(raw.seen) };
      log.info(`Checkpoint loaded: ${data.requests.length} requests, ${data.seen.size} seen URLs`);
      return data;
    } catch (e) {
      log.error(`Failed to load checkpoint (starting fresh): ${(e as Error).message}`);
      return null;
    }
  }

  /** Delete the checkpoint after a successful completion */
  async cleanup(): Promise<void> {
    try {
      await rm(this.checkpointPath, { force: true });
      log.debug("Checkpoint file cleaned up");
    } catch (e) {
      log.warning(`Failed to cleanup checkpoint file: ${(e as Error).message}`);
    }
  }
}
