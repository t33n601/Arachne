import type { Page } from "playwright";

export type PageState = "ready" | "busy" | "error";

/** A page/tab and its current state */
export class PageInfo {
  constructor(
    public page: Page,
    public state: PageState,
    public url: string | null,
  ) {}

  markBusy(url = ""): void {
    this.state = "busy";
    this.url = url;
  }

  /** Mark the page as ready to be reused by the next request */
  markReady(): void {
    this.state = "ready";
    this.url = "";
  }

  markError(): void {
    this.state = "error";
  }

  toString(): string {
    return `Page(URL="${this.url}", state="${this.state}")`;
  }
}

/** Manages a pool of browser pages/tabs with state tracking */
export class PagePool {
  pages: PageInfo[] = [];

  constructor(readonly maxPages = 5) {}

  /** Add a new page to the pool, marked busy for the request that created it */
  addPage(page: Page): PageInfo {
    if (this.pages.length >= this.maxPages) throw new Error(`Maximum page limit (${this.maxPages}) reached`);
    const info = new PageInfo(page, "busy", "");
    this.pages.push(info);
    return info;
  }

  /** Take the first ready page out of the pool, marking it busy, or return `null` */
  getReadyPage(): PageInfo | null {
    for (const info of this.pages) {
      if (info.state === "ready") {
        info.markBusy();
        return info;
      }
    }
    return null;
  }

  /** Forget a page, whether it's still in the pool or not */
  removePage(info: PageInfo): void {
    const idx = this.pages.indexOf(info);
    if (idx !== -1) this.pages.splice(idx, 1);
  }

  /** Forget every page and return them so the caller can close them */
  clear(): PageInfo[] {
    const pages = this.pages;
    this.pages = [];
    return pages;
  }

  get pagesCount(): number {
    return this.pages.length;
  }

  get busyCount(): number {
    return this.pages.filter((info) => info.state === "busy").length;
  }
}
