#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Command, Option } from "commander";

import { parseCookieString, parseHeaders } from "./core/curl.js";
import { rootLogger as log } from "./core/logger.js";
import { writeContentToFile } from "./core/shell.js";
import { VERSION } from "./version.js";
import type { Response } from "./transport/utils/response.js";
import type { RequestOptions } from "./transport/http.js";
import type { StealthSessionOptions } from "./transport/browsers/config.js";

const OUTPUT_FILE_HELP =
  "The output file can be an HTML file, a Markdown file of the HTML content, or the text content itself. Use the `.html`/`.md`/`.txt` extensions respectively.";
const collect = (value: string, previous: string[] = []) => [...previous, value];

function parseRequestArgs(options: Record<string, any>): RequestOptions {
  const [headers, cookies] = parseHeaders(options.headers ?? []);
  if (options.cookies) Object.assign(cookies, parseCookieString(options.cookies));
  const params: Record<string, string> = {};
  for (const param of options.params ?? []) {
    const idx = param.indexOf("=");
    if (idx !== -1) params[param.slice(0, idx)] = param.slice(idx + 1);
  }
  const request: RequestOptions = {
    headers: Object.keys(headers).length ? headers : undefined,
    cookies: Object.keys(cookies).length ? cookies : undefined,
    params: Object.keys(params).length ? params : undefined,
    timeout: Number(options.timeout),
    followRedirects: options.followRedirects ? "safe" : false,
    verify: options.verify,
    stealthHeaders: options.stealthHeaders,
    proxy: options.proxy,
  };
  if (options.impersonate) {
    request.impersonate = (options.impersonate.includes(",")
      ? options.impersonate.split(",").map((b: string) => b.trim())
      : options.impersonate) as RequestOptions["impersonate"];
  }
  if (options.json) {
    try {
      request.json = JSON.parse(options.json);
    } catch (e) {
      throw new Error(`Invalid JSON data '${options.json}': ${(e as Error).message}`);
    }
  }
  if (options.data) request.data = options.data;
  return request;
}

function parseBrowserArgs(options: Record<string, any>): StealthSessionOptions {
  const [headers] = parseHeaders(options.extraHeaders ?? []);
  const result: StealthSessionOptions = {
    headless: options.headless,
    disableResources: options.disableResources,
    networkIdle: options.networkIdle,
    timeout: Number(options.timeout),
    locale: options.locale ?? null,
    realChrome: options.realChrome,
    dnsOverHttps: options.dnsOverHttps,
    blockAds: options.blockAds || options.aiTargeted,
  };
  if (Number(options.wait) > 0) result.wait = Number(options.wait);
  if (options.waitSelector) result.waitSelector = options.waitSelector;
  if (options.proxy) result.proxy = options.proxy;
  if (Object.keys(headers).length) result.extraHeaders = headers;
  const executablePath = options.executablePath || process.env.ARACHNE_EXECUTABLE_PATH;
  if (executablePath) result.executablePath = executablePath;
  return result;
}

async function requestAndSave(fetch: () => Promise<Response>, outputFile: string, cssSelector: string | undefined, aiTargeted: boolean) {
  const output = isAbsolute(outputFile) ? outputFile : resolve(process.cwd(), outputFile);
  const response = await fetch();
  writeContentToFile(response, output, cssSelector, aiTargeted);
  log.info(`Content successfully saved to '${output}'`);
}

function httpOptions(command: Command, withData = false): Command {
  command
    .argument("<url>", "Target URL")
    .argument("<output_file>", "Output file path (.html/.md/.txt)")
    .option("-H, --headers <header>", 'HTTP header in "Key: Value" format (repeatable)', collect)
    .option("--cookies <cookies>", 'Cookies string "name1=value1; name2=value2"')
    .option("--timeout <seconds>", "Request timeout in seconds", "30")
    .option("--proxy <url>", 'Proxy URL "http://username:password@host:port"')
    .option("-s, --css-selector <selector>", "CSS selector to extract specific content, all matches are returned")
    .option("-p, --params <param>", 'Query parameter "key=value" (repeatable)', collect)
    .option("--no-follow-redirects", "Don't follow redirects")
    .option("--no-verify", "Don't verify SSL certificates")
    .option("--impersonate <browser>", "Browser to impersonate, comma-separated for random selection (e.g. chrome,firefox)")
    .option("--no-stealth-headers", "Don't generate real browser headers")
    .option("--ai-targeted", "Extract only the main content and drop hidden elements for AI consumption", false);
  if (withData) command.option("-d, --data <data>", 'Form data "param1=value1&param2=value2"').option("-j, --json <json>", "JSON body as a string");
  return command;
}

function browserOptions(command: Command): Command {
  return command
    .argument("<url>", "Target URL")
    .argument("<output_file>", "Output file path (.html/.md/.txt)")
    .option("--no-headless", "Show the browser window")
    .option("--disable-resources", "Drop unnecessary resources for a speed boost", false)
    .option("--network-idle", "Wait for the network to be idle", false)
    .option("--timeout <ms>", "Timeout in milliseconds", "30000")
    .option("--wait <ms>", "Extra wait time in milliseconds after the page loads", "0")
    .option("-s, --css-selector <selector>", "CSS selector to extract specific content, all matches are returned")
    .option("--wait-selector <selector>", "CSS selector to wait for before proceeding")
    .option("--locale <locale>", "User locale, the system's by default")
    .option("--real-chrome", "Use your installed Chrome browser", false)
    .option("--proxy <url>", 'Proxy URL "http://username:password@host:port"')
    .option("-H, --extra-headers <header>", 'Extra header in "Key: Value" format (repeatable)', collect)
    .option("--dns-over-https", "Route DNS through Cloudflare's DoH to prevent DNS leaks with proxies", false)
    .option("--block-ads", "Block requests to known ad and tracker domains", false)
    .option("--executable-path <path>", "Custom Chromium-based browser executable (or ARACHNE_EXECUTABLE_PATH)")
    .option("--ai-targeted", "Extract only the main content and drop hidden elements for AI consumption", false);
}

const program = new Command();
program.name("arachne").description("Arachne command line interface").version(VERSION, "-V, --version");

program
  .command("install")
  .description("Install the browsers and their system dependencies")
  .option("-f, --force", "Install even if already installed", false)
  .action(() => {
    const require = createRequire(import.meta.url);
    for (const pkg of ["playwright", "patchright"]) {
      let cli: string;
      try {
        cli = join(dirname(require.resolve(`${pkg}/package.json`)), "cli.js");
      } catch {
        continue;
      }
      console.log(`Installing ${pkg} browsers...`);
      const args = process.platform === "linux" ? ["install", "--with-deps", "chromium"] : ["install", "chromium"];
      const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  });

program
  .command("mcp")
  .description("Run the MCP server for AI agents (stdio by default)")
  .option("--http", "Use the streamable-http transport instead of stdio", false)
  .option("--host <host>", "Host for the HTTP transport", "127.0.0.1")
  .option("--port <port>", "Port for the HTTP transport", "8000")
  .option("--executable-path <path>", "Default Chromium-based browser executable for the browser tools")
  .option("--auth-token <token>", "Bearer token required on the HTTP transport (prefer ARACHNE_MCP_AUTH_TOKEN)")
  .option("--allowed-host <host>", "Host allowed by the DNS-rebinding protection (repeatable)", collect)
  .option("--no-auth", "Allow serving over HTTP without a token")
  .action(async (options) => {
    const { ArachneMcpServer } = await import("./ai/mcp.js");
    const server = new ArachneMcpServer({ executablePath: options.executablePath, authToken: options.authToken });
    try {
      await server.serve({
        http: options.http,
        host: options.host,
        port: Number(options.port),
        allowedHosts: options.allowedHost ?? [],
        allowUnauthenticated: options.auth === false,
      });
    } catch (e) {
      program.error((e as Error).message);
    }
  });

program
  .command("shell")
  .description("An interactive scraping shell")
  .option("-c, --code <code>", "Evaluate the code in the shell, print the result and exit", "")
  .addOption(new Option("-L, --loglevel <level>", "Log level").choices(["debug", "info", "warning", "error", "critical", "fatal"]).default("debug"))
  .action(async (options) => {
    const { InteractiveShell } = await import("./core/shell.js");
    await new InteractiveShell(options.code, options.loglevel).start();
  });

const extract = program.command("extract").description(`Fetch web pages and save their content to files.\n\n${OUTPUT_FILE_HELP}`);

for (const method of ["get", "post", "put", "delete"] as const) {
  httpOptions(extract.command(method).description(`Perform a ${method.toUpperCase()} request and save the content to a file.`), method === "post" || method === "put").action(
    async (url: string, outputFile: string, options: Record<string, any>) => {
      const { Http } = await import("./clients/http.js");
      const request = parseRequestArgs(options);
      await requestAndSave(() => Http[method](url, request), outputFile, options.cssSelector, options.aiTargeted);
    },
  );
}

browserOptions(extract.command("browser").description("Fetch the content with a browser (Browser)")).action(
  async (url: string, outputFile: string, options: Record<string, any>) => {
    const { Browser } = await import("./clients/browser.js");
    await requestAndSave(() => Browser.fetch(url, parseBrowserArgs(options)), outputFile, options.cssSelector, options.aiTargeted);
  },
);

browserOptions(extract.command("stealth").description("Fetch the content with the stealth browser (StealthBrowser)"))
  .option("--block-webrtc", "Block WebRTC IP leaks", false)
  .option("--solve-cloudflare", "Solve Cloudflare challenges", false)
  .option("--no-allow-webgl", "Disable WebGL")
  .option("--hide-canvas", "Add noise to canvas operations", false)
  .action(async (url: string, outputFile: string, options: Record<string, any>) => {
    const { StealthBrowser } = await import("./clients/stealth-browser.js");
    const browser = {
      ...parseBrowserArgs(options),
      blockWebrtc: options.blockWebrtc,
      solveCloudflare: options.solveCloudflare,
      allowWebgl: options.allowWebgl,
      hideCanvas: options.hideCanvas,
    };
    await requestAndSave(() => StealthBrowser.fetch(url, browser), outputFile, options.cssSelector, options.aiTargeted);
  });

program.parseAsync(process.argv).catch((e) => {
  log.error(((e as Error).message ?? String(e)).split("\n", 1)[0]);
  process.exit(1);
});
