import { gunzipSync } from "node:zlib";

const GUNZIP_MAX_SIZE = 64 * 1024 * 1024; // 64 MiB cap, defends against gzip bombs

/** Gunzip the body when the content-type or the magic bytes say it's gzipped, capped against gzip bombs */
export function decompress(body: Uint8Array, contentType?: string | null): Uint8Array {
  const gzipped = (contentType && contentType.toLowerCase().includes("gzip")) || (body[0] === 0x1f && body[1] === 0x8b);
  if (!gzipped) return body;
  try {
    return new Uint8Array(gunzipSync(body, { maxOutputLength: GUNZIP_MAX_SIZE }));
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    if (error.code === "ERR_BUFFER_TOO_LARGE" || /too large|maxOutputLength/i.test(error.message)) {
      throw new Error(`gzip output exceeds ${GUNZIP_MAX_SIZE} bytes`);
    }
    throw new Error(`Failed to decompress: ${error.message}`);
  }
}
