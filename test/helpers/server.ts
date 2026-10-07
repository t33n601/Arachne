import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>;

export interface TestServer {
  url: string;
  hits: Map<string, number>;
  close(): Promise<void>;
}

/** Start a local HTTP server with a route table (`"GET /path"` or `"/path"` keys) */
export async function startServer(routes: Record<string, Handler>): Promise<TestServer> {
  const hits = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf-8");
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const handler = routes[`${req.method} ${path}`] ?? routes[path];
    if (!handler) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>not found</body></html>");
      return;
    }
    try {
      await handler(req, res, body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function html(res: ServerResponse, content: string, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(content);
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
