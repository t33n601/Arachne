import { BaseClient, type Response } from "../transport/utils/response.js";
import { HttpClient, HttpSession, type RequestOptions } from "../transport/http.js";

export { HttpSession };

const client = new HttpClient();

function withParserSettings(cls: typeof BaseClient, options: RequestOptions): RequestOptions {
  // Values from `Http.configure()` are the base, an explicit `selectorConfig` on the call overrides them
  return { ...options, selectorConfig: cls.generateParserArguments(options.selectorConfig ?? {}) };
}

/** Plain HTTP requests (GET, POST, PUT, DELETE) with browser impersonation, no session needed */
export class Http extends BaseClient {
  static get(url: string, options: Omit<RequestOptions, "data" | "json"> = {}): Promise<Response> {
    return client.get(url, withParserSettings(this, options));
  }

  static post(url: string, options: RequestOptions = {}): Promise<Response> {
    return client.post(url, withParserSettings(this, options));
  }

  static put(url: string, options: RequestOptions = {}): Promise<Response> {
    return client.put(url, withParserSettings(this, options));
  }

  static delete(url: string, options: RequestOptions = {}): Promise<Response> {
    return client.delete(url, withParserSettings(this, options));
  }
}

/** Everything is asynchronous in JavaScript, so this is the same as `Http` (kept for API familiarity) */
export const AsyncHttp = Http;
