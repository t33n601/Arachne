import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../core/logger.js";
import { Response, type BrowserCookie } from "../transport/utils/response.js";

interface CachedResponse {
  url: string;
  content: string;
  status: number;
  reason: string;
  encoding: string;
  cookies: Record<string, string> | BrowserCookie[];
  headers: Record<string, string>;
  request_headers: Record<string, string>;
  method: string;
}

/** Caches responses to disk to replay them while developing crawlers */
export class ResponseCacheManager {
  constructor(private readonly cacheDir: string) {}

  private cachePath(fingerprint: string): string {
    return join(this.cacheDir, `${fingerprint}.json`);
  }

  async get(fingerprint: string): Promise<Response | null> {
    let raw: string;
    try {
      raw = await readFile(this.cachePath(fingerprint), "utf-8");
    } catch {
      return null;
    }
    try {
      const data = JSON.parse(raw) as CachedResponse;
      return new Response({
        url: data.url,
        content: new Uint8Array(Buffer.from(data.content, "base64")),
        status: data.status,
        reason: data.reason,
        encoding: data.encoding,
        // Browser cookies come back as an array and HTTP ones as an object, each keeping its shape
        cookies: data.cookies,
        headers: data.headers,
        requestHeaders: data.request_headers,
        method: data.method,
      });
    } catch (e) {
      log.warning(`Failed to read cached response for ${fingerprint}: ${(e as Error).message}`);
      return null;
    }
  }

  async put(fingerprint: string, response: Response, method = "GET"): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const target = this.cachePath(fingerprint);
    const temp = `${target.slice(0, -5)}.tmp`;
    try {
      const data: CachedResponse = {
        url: response.url,
        content: Buffer.from(response.body).toString("base64"),
        status: response.status,
        reason: response.reason,
        encoding: response.encoding,
        cookies: Array.isArray(response.cookies) ? [...response.cookies] : { ...response.cookies },
        headers: { ...response.headers },
        request_headers: { ...response.requestHeaders },
        method,
      };
      await writeFile(temp, JSON.stringify(data));
      await rename(temp, target);
    } catch (e) {
      await rm(temp, { force: true });
      log.warning(`Failed to cache response for ${fingerprint}: ${(e as Error).message}`);
    }
  }

  async clear(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.cacheDir);
    } catch {
      return;
    }
    await Promise.all(entries.filter((name) => name.endsWith(".json")).map((name) => rm(join(this.cacheDir, name), { force: true })));
    log.info(`Cleared response cache at ${this.cacheDir}`);
  }
}
