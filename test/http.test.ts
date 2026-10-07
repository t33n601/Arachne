import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Http, HttpSession, ProxyRotator } from "../src/clients/index.js";
import { Response } from "../src/transport/utils/response.js";
import { html, json, startServer, type TestServer } from "./helpers/server.js";

let server: TestServer;

beforeAll(async () => {
  server = await startServer({
    "/": (_req, res) => html(res, `<html><head><title>Home</title></head><body><a href="/next">next</a></body></html>`),
    "/headers": (req, res) => json(res, req.headers),
    "GET /echo": (req, res) => json(res, { method: "GET", url: req.url }),
    "POST /echo": (req, res, body) => json(res, { method: "POST", body, type: req.headers["content-type"] }),
    "PUT /echo": (req, res, body) => json(res, { method: "PUT", body }),
    "DELETE /echo": (_req, res) => json(res, { method: "DELETE" }),
    "/set-cookie": (_req, res) => {
      res.writeHead(200, { "set-cookie": ["session=abc; Path=/", "theme=dark; Path=/"], "content-type": "text/plain" });
      res.end("ok");
    },
    "/cookies": (req, res) => json(res, { cookie: req.headers.cookie ?? null }),
    "/redirect": (_req, res) => {
      res.writeHead(302, { location: "/" });
      res.end();
    },
    "/redirect-chain": (_req, res) => {
      res.writeHead(301, { location: "/redirect" });
      res.end();
    },
    "/post-redirect": (_req, res) => {
      res.writeHead(303, { location: "/echo" });
      res.end();
    },
    "/latin1": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=windows-1251" });
      res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x3c, 0x2f, 0x70, 0x3e]));
    },
  });
});

afterAll(async () => {
  await server.close();
});

describe("Http", () => {
  it("fetches and parses pages", async () => {
    const page = await Http.get(`${server.url}/`, { impersonate: null });
    expect(page).toBeInstanceOf(Response);
    expect(page.status).toBe(200);
    expect(page.reason).toBe("OK");
    expect(page.css("title::text").get()!.valueOf()).toBe("Home");
    expect(page.urljoin("/next")).toBe(`${server.url}/next`);
    expect(page.header("Content-Type")).toContain("text/html");
  });

  it("supports all HTTP methods with params, form data, and JSON", async () => {
    const get = await Http.get(`${server.url}/echo`, { params: { q: "x y", n: 1 } });
    expect(get.json().url).toBe("/echo?q=x+y&n=1");
    const post = await Http.post(`${server.url}/echo`, { data: { a: "1", b: "2" } });
    expect(post.json()).toEqual({ method: "POST", body: "a=1&b=2", type: "application/x-www-form-urlencoded" });
    const postJson = await Http.post(`${server.url}/echo`, { json: { hello: "world" } });
    expect(postJson.json().body).toBe('{"hello":"world"}');
    expect((await Http.put(`${server.url}/echo`, { data: "raw" })).json()).toEqual({ method: "PUT", body: "raw" });
    expect((await Http.delete(`${server.url}/echo`)).json().method).toBe("DELETE");
  });

  it("sends stealth headers by default and real browser headers without impersonation", async () => {
    const headers = (await Http.get(`${server.url}/headers`, { impersonate: null })).json();
    expect(headers.referer).toBe("https://www.google.com/");
    expect(headers["user-agent"]).toMatch(/Mozilla\/5\.0/);
    const plain = (await Http.get(`${server.url}/headers`, { impersonate: null, stealthHeaders: false, headers: { "x-custom": "1" } })).json();
    expect(plain.referer).toBeUndefined();
    expect(plain["x-custom"]).toBe("1");
    expect(plain["user-agent"]).toMatch(/Mozilla\/5\.0/);
  });

  it("impersonates a browser", async () => {
    const headers = (await Http.get(`${server.url}/headers`)).json();
    expect(headers["user-agent"]).toMatch(/Chrome\/\d+/);
    expect(headers["sec-ch-ua"]).toBeDefined();
  });

  it("follows redirects with history", async () => {
    const page = await Http.get(`${server.url}/redirect-chain`, { followRedirects: true });
    expect(page.url).toBe(`${server.url}/`);
    expect(page.history.map((r) => r.status)).toEqual([301, 302]);
    const noFollow = await Http.get(`${server.url}/redirect`, { followRedirects: false });
    expect(noFollow.status).toBe(302);
    await expect(Http.get(`${server.url}/redirect-chain`, { followRedirects: true, maxRedirects: 1, retries: 1 })).rejects.toThrow(/redirects/);
  });

  it("rejects redirects to internal addresses in safe mode", async () => {
    await expect(Http.get(`${server.url}/redirect`, { retries: 1 })).rejects.toThrow(/internal/);
  });

  it("switches to GET after a 303", async () => {
    const page = await Http.post(`${server.url}/post-redirect`, { data: "x", followRedirects: true });
    expect(page.json().method).toBe("GET");
  });

  it("decodes non utf-8 pages", async () => {
    const page = await Http.get(`${server.url}/latin1`);
    expect(page.encoding).toBe("windows-1251");
    expect(page.css("p::text").get()!.valueOf()).toBe("Привет");
  });

  it("retries and fails on connection errors", async () => {
    const start = Date.now();
    await expect(Http.get("http://127.0.0.1:1/", { retries: 2, retryDelay: 0.1, timeout: 2 })).rejects.toThrow();
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it("applies the global parser configuration", async () => {
    class MyClient extends Http {}
    MyClient.configure({ keepComments: true });
    expect(MyClient.displayConfig().keepComments).toBe(true);
    expect(Http.displayConfig().keepComments).toBe(false);
    expect(() => MyClient.configure({ nope: 1 } as never)).toThrow(/Unknown parser argument/);
    expect(() => MyClient.configure({})).toThrow();
  });
});

describe("HttpSession", () => {
  it("keeps cookies between requests", async () => {
    const session = await new HttpSession({ impersonate: null }).start();
    try {
      const set = await session.get(`${server.url}/set-cookie`);
      expect(set.cookies).toEqual({ session: "abc", theme: "dark" });
      const echoed = (await session.get(`${server.url}/cookies`)).json();
      expect(echoed.cookie).toContain("session=abc");
      expect(echoed.cookie).toContain("theme=dark");
      const extra = (await session.get(`${server.url}/cookies`, { cookies: { extra: "1" } })).json();
      expect(extra.cookie).toContain("extra=1");
    } finally {
      await session.close();
    }
    // One-off clients don't keep cookies
    await Http.get(`${server.url}/set-cookie`);
    expect((await Http.get(`${server.url}/cookies`)).json().cookie).toBeNull();
  });

  it("refuses requests when closed and double starts", async () => {
    const session = new HttpSession();
    await expect(session.get(`${server.url}/`)).rejects.toThrow(/start/);
    await session.start();
    await expect(session.start()).rejects.toThrow();
    await session.close();
  });

  it("supports `await using`", async () => {
    let status = 0;
    {
      await using session = await new HttpSession().start();
      status = (await session.get(`${server.url}/`)).status;
    }
    expect(status).toBe(200);
  });

  it("rejects proxy rotation together with a static proxy", () => {
    expect(() => new HttpSession({ proxy: "http://p:1", proxyRotator: new ProxyRotator(["http://a:1"]) })).toThrow();
  });
});

describe("ProxyRotator", () => {
  it("rotates cyclically and supports custom strategies", () => {
    const rotator = new ProxyRotator(["http://a:1", { server: "http://b:2", username: "u", password: "p" }]);
    expect(rotator.getProxy()).toBe("http://a:1");
    expect(rotator.getProxy()).toEqual({ server: "http://b:2", username: "u", password: "p" });
    expect(rotator.getProxy()).toBe("http://a:1");
    expect(rotator.length).toBe(2);
    const fixed = new ProxyRotator(["http://a:1", "http://b:2"], (proxies) => [proxies[1]!, 0]);
    expect(fixed.getProxy()).toBe("http://b:2");
    expect(() => new ProxyRotator([])).toThrow();
    expect(() => new ProxyRotator([{ host: "x" } as never])).toThrow();
  });
});
