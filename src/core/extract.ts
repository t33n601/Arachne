/** Conversion of pages to Markdown/HTML/text, with the cleaning used for AI consumption */
import TurndownService from "turndown";

import { Node, type NodeList } from "../parser.js";
import { Element, cloneIntoDocument, Text, ELEMENT_NODE } from "../dom/nodes.js";
import { TextValue } from "./text.js";

export type ExtractionType = "markdown" | "html" | "text";

const NOISE_TAGS = new Set(["script", "style", "noscript", "svg"]);
const HIDDEN_STYLE_RE =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d])|height\s*:\s*0(?![.\d])|width\s*:\s*0(?![.\d])/i;
const ZWC_RE = /[​‌‍﻿⁠᠎]/g;
export const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

let turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "*",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    });
    turndown.remove(["script", "style", "noscript", "template"]);
  }
  return turndown;
}

function cloneRoot(page: Node): Element {
  const doc = cloneIntoDocument(page._root as Element);
  return doc.documentElement!;
}

function dropMatching(root: Element, shouldDrop: (element: Element) => boolean): void {
  const targets: Element[] = [];
  for (const element of root.descendantElements()) {
    if (shouldDrop(element)) targets.push(element);
  }
  for (const element of targets) element.parentNode?.removeChild(element);
}

export const ContentExtractor = {
  extensionMap: { md: "markdown", html: "html", txt: "text" } as Record<string, ExtractionType>,

  /** Convert HTML content to Markdown */
  toMarkdown(html: string): string {
    return getTurndown().turndown(html);
  },

  /** A copy of the page without scripts, styles, noscript, and svg elements */
  stripNoiseTags(page: Node): Node {
    if (page.isTextNode) return page;
    const root = cloneRoot(page);
    dropMatching(root, (element) => NOISE_TAGS.has(element.tagName));
    root.ownerDocument?.reindex();
    return new Node(null, { root, url: page.url });
  },

  /**
   * A copy of the page without hidden content that could be used for prompt injection: CSS-hidden and aria-hidden
   * elements, `<template>` tags, comments, zero-width characters, and XML-incompatible control characters.
   */
  sanitizeForAi(page: Node): Node {
    if (page.isTextNode) return page;
    const root = cloneRoot(page);
    dropMatching(
      root,
      (element) =>
        element.tagName === "template" ||
        element.getAttribute("aria-hidden") === "true" ||
        HIDDEN_STYLE_RE.test(element.getAttribute("style") ?? ""),
    );
    const comments = [];
    for (const node of root.descendants()) {
      if (node instanceof Text) node.data = node.data.replace(ZWC_RE, "").replace(CONTROL_CHARS_RE, "");
      else if (node.nodeType === 8) comments.push(node);
    }
    for (const comment of comments) comment.parentNode?.removeChild(comment);
    root.ownerDocument?.reindex();
    return new Node(null, { root, url: page.url });
  },

  /** Yield the content of a page (or the elements matching the CSS selector) in the requested format */
  *extractContent(
    page: Node,
    extractionType: ExtractionType = "markdown",
    cssSelector?: string | null,
    mainContentOnly = false,
  ): Generator<string> {
    if (!(page instanceof Node)) throw new TypeError("Input must be of type `Node`");
    if (!["markdown", "html", "text"].includes(extractionType)) throw new Error(`Unknown extraction type: ${extractionType}`);

    if (mainContentOnly) {
      page = page.css("body").first ?? page;
      page = ContentExtractor.stripNoiseTags(page);
      page = ContentExtractor.sanitizeForAi(page);
    }

    const pages: Node[] | NodeList = cssSelector ? page.css(cssSelector) : [page];
    for (const item of pages) {
      if (extractionType === "markdown") {
        yield ContentExtractor.toMarkdown(item.htmlContent.valueOf());
      } else if (extractionType === "html") {
        yield item.htmlContent.valueOf();
      } else {
        let text = item.getAllText({ strip: true, ignoreTags: ["script", "style", "noscript", "svg", "iframe"] }).valueOf();
        // Remove consecutive white-spaces
        for (const s of ["\n", "\r", "\t", " "]) text = text.replace(new RegExp(`[${s}]+`, "g"), s);
        yield text;
      }
    }
    yield "";
  },

  /** Markdown of a page (or of the elements matching the CSS selector) after removing noise and hidden content */
  pageToMarkdown(page: Node, cssSelector?: string | null, mainContentOnly = false): string {
    let target: Node = mainContentOnly ? (page.css("body").first ?? page) : page;
    target = ContentExtractor.sanitizeForAi(ContentExtractor.stripNoiseTags(target));
    const pages = cssSelector ? [...target.css(cssSelector)] : [target];
    return pages.map((element) => ContentExtractor.toMarkdown(element.htmlContent.valueOf())).join("");
  },
};

/** Helper used by the CLI to check for elements */
export function isElementSelector(selector: Node): boolean {
  return selector._root.nodeType === ELEMENT_NODE;
}

export { TextValue };
