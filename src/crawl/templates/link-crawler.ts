import type { Response } from "../../transport/utils/response.js";
import type { LinkExtractor } from "../links.js";
import type { CallbackResult, Request, RequestCallback } from "../request.js";
import { Crawler } from "../crawler.js";

/** A rule for `LinkCrawler`: extract links from each response and dispatch them */
export class CrawlRule {
  /**
   * @param linkExtractor Produces the URLs from each response
   * @param options.callback The crawler method called for each matched URL (`parse()` by default)
   * @param options.priority Override the priority of the dispatched requests
   * @param options.processRequest Mutate each `Request` before it's yielded (add headers, change priority...)
   */
  constructor(
    readonly linkExtractor: LinkExtractor,
    readonly options: {
      callback?: RequestCallback | null;
      priority?: number | null;
      processRequest?: ((request: Request, response: Response) => Request) | null;
    } = {},
  ) {}

  get callback(): RequestCallback | null {
    return this.options.callback ?? null;
  }

  get priority(): number | null {
    return this.options.priority ?? null;
  }

  get processRequest(): ((request: Request, response: Response) => Request) | null {
    return this.options.processRequest ?? null;
  }
}

/**
 * A generic crawler that extracts and follows links automatically based on crawl rules. Override `rules()` to return a
 * list of `CrawlRule`s.
 */
export abstract class LinkCrawler extends Crawler {
  /** Override to define link-following rules */
  rules(): CrawlRule[] {
    return [];
  }

  async *parse(response: Response): AsyncGenerator<CallbackResult> {
    for (const rule of this.rules()) {
      for (const url of rule.linkExtractor.extract(response)) {
        let request = response.follow(url, { callback: rule.callback });
        if (rule.priority !== null) request.priority = rule.priority;
        if (rule.processRequest) request = rule.processRequest.call(this, request, response);
        yield request;
      }
    }
  }
}
