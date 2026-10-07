import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "arachne-test-"));
  process.env.ARACHNE_STORAGE = join(dir, "tracked_elements.db");
  return () => rmSync(dir, { recursive: true, force: true });
}
