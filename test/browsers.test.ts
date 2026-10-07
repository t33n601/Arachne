import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Browser, BrowserSession, StealthBrowser, StealthBrowserSession } from "../src/clients/index.js";
import { detectCloudflare } from "../src/transport/browsers/stealth.js";
import { html, json, startServer, type TestServer } from "./helpers/server.js";

let server: TestServer;

beforeAll(async () => {
  server = await startServer({
    "/": (_req, res) =>
      html(
        res,
        `<html><head><title>JS page</title></head><body><div id="app">loading</div>
         <script>
           setTimeout(() => { document.getElementById('app').innerHTML = '<p class="ready">Rendered</p>'; }, 300);
           fetch('/api/data').then(r => r.json()).then(d => { document.body.dataset.items = d.items.length; });
         </script></body></html>`,
      ),
    "/api/data": (_req, res) => json(res, { items: [1, 2, 3] }),
    "/headers": (req, res) => html(res, `<pre id="h">${JSON.stringify(req.headers)}</pre>`),
    "/redirect": (_req, res) => {
      res.writeHead(302, { location: "/headers" });
      res.end();
    },
    "/image-page": (_req, res) => html(res, `<img src="/pixel.png"><p>ok</p>`),
    "/pixel.png": (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(10));
    },
    "/webdriver": (_req, res) => html(res, `<p id="w"></p><script>document.getElementById('w').textContent = String(navigator.webdriver)</script>`),
  });
});

afterAll(async () => {
  await server.close();
});

describe("BrowserSession", () => {
  it("renders JavaScript and waits for selectors", async () => {
    const page = await Browser.fetch(`${server.url}/`, { waitSelector: ".ready", networkIdle: true });
    expect(page.status).toBe(200);
    expect(page.css(".ready::text").get()!.valueOf()).toBe("Rendered");
    expect(page.css("body").first!.attr("data-items").valueOf()).toBe("3");
    expect(Array.isArray(page.cookies)).toBe(true);
  });

  it("pools pages, captures XHR, runs page actions, and keeps redirect history", async () => {
    const session = await new BrowserSession({ maxPages: 2, captureXhr: "/api/", googleSearch: false }).start();
    try {
      const pages = await Promise.all([
        session.fetch(`${server.url}/`, { networkIdle: true }),
        session.fetch(`${server.url}/`, { networkIdle: true }),
        session.fetch(`${server.url}/headers`),
      ]);
      expect(pages.map((p) => p.status)).toEqual([200, 200, 200]);
      expect(session.getPoolStats()).toEqual({ totalPages: 2, busyPages: 0, maxPages: 2 });
      expect(pages[0]!.capturedXhr[0]!.json()).toEqual({ items: [1, 2, 3] });

      let title = "";
      await session.fetch(`${server.url}/`, {
        pageAction: async (page) => {
          title = await page.title();
        },
      });
      expect(title).toBe("JS page");

      const redirected = await session.fetch(`${server.url}/redirect`);
      expect(redirected.url).toBe(`${server.url}/headers`);
      expect(redirected.history.map((r) => r.status)).toEqual([302]);
    } finally {
      await session.close();
    }
    expect(session.isAlive).toBe(false);
  });

  it("blocks resources and sets headers", async () => {
    const session = await new BrowserSession({ disableResources: true, extraHeaders: { "x-test": "1" } }).start();
    try {
      await session.fetch(`${server.url}/image-page`);
      const headers = JSON.parse((await session.fetch(`${server.url}/headers`)).css("#h::text").get()!.valueOf());
      expect(headers["x-test"]).toBe("1");
      expect(headers.referer).toBe("https://www.google.com/");
      expect(headers["user-agent"]).not.toContain("Headless");
    } finally {
      await session.close();
    }
    expect(server.hits.get("/pixel.png") ?? 0).toBe(0);
  });

  it("validates options", () => {
    expect(() => new BrowserSession({ maxPages: 0 })).toThrow(/maxPages/);
    expect(() => new BrowserSession({ timeout: "x" as never })).toThrow(/timeout/);
    expect(() => new BrowserSession({ cdpUrl: "ftp://x" })).toThrow(/CDP/);
    expect(() => new BrowserSession({ initScript: "relative.js" })).toThrow(/not found/);
  });
});

describe("StealthBrowserSession", () => {
  it("hides automation markers", async () => {
    const page = await StealthBrowser.fetch(`${server.url}/webdriver`, { hideCanvas: true });
    expect(page.css("#w::text").get()!.valueOf()).toBe("false");
  });

  it("refuses Cloudflare solving outside stealth sessions and detects challenges", async () => {
    const session = await new BrowserSession().start();
    try {
      await expect(session.fetch(`${server.url}/`, { solveCloudflare: true })).rejects.toThrow(/stealth/);
    } finally {
      await session.close();
    }
    expect(detectCloudflare("<script>window._cf_chl_opt={cType: 'managed'}</script>")).toBe("managed");
    expect(detectCloudflare('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>')).toBe("embedded");
    expect(detectCloudflare("<p>hi</p>")).toBeNull();
    expect(new StealthBrowserSession({ solveCloudflare: true }).config.timeout).toBe(60_000);
  });
});
