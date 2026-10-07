/** Parsing curl commands (as copied from the browser DevTools' network tab) into client requests */
import { log } from "./logger.js";

/** Split a command line like a POSIX shell does (quotes, escapes, line continuations) */
export function shellSplit(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1]!)) {
        const next = command[++i]!;
        if (next !== "\n") current += next;
      } else current += char;
      continue;
    }
    if (char === "\\") {
      const next = command[++i];
      if (next === undefined) throw new Error("No escaped character");
      if (next !== "\n") {
        current += next;
        inToken = true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    current += char;
    inToken = true;
  }
  if (quote) throw new Error("No closing quotation");
  if (inToken) tokens.push(current);
  return tokens;
}

/** Parse a `Cookie` header value into a name/value map */
export function parseCookieString(cookieString: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieString.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    cookies[part.slice(0, idx).trim()] = value;
  }
  return cookies;
}

/** Parse header lines into headers and cookies (the `Cookie` header is turned into cookies) */
export function parseHeaders(lines: string[], parseCookies = true): [Record<string, string>, Record<string, string>] {
  const headers: Record<string, string> = {};
  let cookies: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      if (line.endsWith(";")) headers[line.slice(0, -1).trim()] = "";
      else throw new Error(`Could not parse header without colon: '${line}'.`);
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (parseCookies && key.toLowerCase() === "cookie") cookies = parseCookieString(value);
    else headers[key] = value;
  }
  return [headers, cookies];
}

/** The parsed form of a curl command */
export interface CurlRequest {
  method: "get" | "post" | "put" | "delete" | string;
  url: string;
  params: Record<string, string>;
  data: string | Uint8Array | Record<string, string> | null;
  json: unknown;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  proxies: Record<string, string> | null;
  followRedirects: "safe";
  verify: boolean;
}

const VALUE_FLAGS: Record<string, string> = {
  "-X": "method",
  "--request": "method",
  "-H": "header",
  "--header": "header",
  "-A": "userAgent",
  "--user-agent": "userAgent",
  "-d": "data",
  "--data": "data",
  "--data-raw": "dataRaw",
  "--data-binary": "dataBinary",
  "--data-ascii": "data",
  "--data-urlencode": "dataUrlencode",
  "-b": "cookie",
  "--cookie": "cookie",
  "-x": "proxy",
  "--proxy": "proxy",
  "-U": "proxyUser",
  "--proxy-user": "proxyUser",
  "-e": "referer",
  "--referer": "referer",
  "-u": "user",
  "--user": "user",
};
const BOOLEAN_FLAGS: Record<string, string> = {
  "-G": "get",
  "--get": "get",
  "-k": "insecure",
  "--insecure": "insecure",
  "--compressed": "compressed",
  "-i": "include",
  "--include": "include",
  "-s": "silent",
  "--silent": "silent",
  "-v": "verbose",
  "--verbose": "verbose",
  "-L": "location",
  "--location": "location",
};

/** Parse a curl command into a request description, throws on unsupported arguments */
export function parseCurl(command: string): CurlRequest {
  const clean = command.trim().replace(/^curl\b/, "").replace(/\\\r?\n/g, " ").trim();
  const tokens = shellSplit(clean);
  const values: Record<string, string[]> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i]!;
    let inline: string | undefined;
    if (token.startsWith("--") && token.includes("=")) {
      inline = token.slice(token.indexOf("=") + 1);
      token = token.slice(0, token.indexOf("="));
    }
    if (VALUE_FLAGS[token]) {
      const value = inline ?? tokens[++i];
      if (value === undefined) throw new Error(`Curl arguments parsing error: argument ${token}: expected one argument`);
      (values[VALUE_FLAGS[token]!] ??= []).push(value);
    } else if (BOOLEAN_FLAGS[token]) {
      flags.add(BOOLEAN_FLAGS[token]!);
    } else if (token === "--url") {
      positional.push(tokens[++i] ?? "");
    } else if (token.startsWith("-") && token.length > 1) {
      unknown.push(token);
    } else {
      positional.push(token);
    }
  }
  if (unknown.length) throw new Error(`Unknown/Unsupported curl arguments: ${JSON.stringify(unknown)}`);
  const url = positional[0];
  if (!url) throw new Error("Curl arguments parsing error: the following arguments are required: url");

  const last = (key: string) => values[key]?.[values[key]!.length - 1];
  let method = "get";
  const dataPresent = Boolean(values.data || values.dataRaw || values.dataBinary || values.dataUrlencode);
  if (flags.has("get")) method = "get";
  else if (last("method")) method = last("method")!.trim().toLowerCase();
  else if (dataPresent) method = "post";

  const [headers, cookies] = parseHeaders(values.header ?? []);
  if (last("userAgent") && !Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) headers["User-Agent"] = last("userAgent")!;
  if (last("referer")) headers.Referer = last("referer")!;
  if (last("user")) headers.Authorization = `Basic ${Buffer.from(last("user")!).toString("base64")}`;
  if (last("cookie")) {
    Object.assign(cookies, parseCookieString(last("cookie")!));
    log.debug(`Parsed cookies from -b argument: ${Object.keys(cookies).join(", ")}`);
  }

  // Precedence: --data-binary > --data-raw / -d > --data-urlencode
  let data: CurlRequest["data"] = null;
  let json: unknown = null;
  if (last("dataBinary") !== undefined) data = new TextEncoder().encode(last("dataBinary")!);
  else if (last("dataRaw") !== undefined) data = last("dataRaw")!.replace(/^\$+/, "");
  else if (last("data") !== undefined) data = values.data!.join("&");
  else if (values.dataUrlencode) data = Object.fromEntries(new URLSearchParams(values.dataUrlencode.join("&")));

  // Raw data that looks like JSON is sent as JSON
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") {
        json = parsed;
        data = null;
      }
    } catch {
      // Not JSON
    }
  }

  // With `-G` (or a GET method) the data goes to the query string
  const params: Record<string, string> = {};
  if (method === "get" && data) {
    if (typeof data === "string") Object.assign(params, Object.fromEntries(new URLSearchParams(data)));
    else if (!(data instanceof Uint8Array)) Object.assign(params, data);
    if (Object.keys(params).length) {
      data = null;
      json = null;
    }
  }

  let proxies: Record<string, string> | null = null;
  if (last("proxy")) {
    let proxyUrl = last("proxy")!.includes("://") ? last("proxy")! : `http://${last("proxy")}`;
    if (last("proxyUser")) {
      const parsed = new URL(proxyUrl);
      const [user, pass = ""] = last("proxyUser")!.split(":");
      parsed.username = user!;
      parsed.password = pass;
      proxyUrl = parsed.href.replace(/\/$/, "");
    }
    proxies = { http: proxyUrl, https: proxyUrl };
  }

  return {
    method,
    url,
    params,
    data,
    json,
    headers,
    cookies,
    proxies,
    followRedirects: "safe",
    verify: !flags.has("insecure"),
  };
}
