/**
 * CSS selection over our DOM with `css-select`, plus Parsel/Scrapy-style pseudo-elements:
 * `::text` (the text nodes directly under the matched elements) and `::attr(name)` (attribute values).
 *
 * Matching follows Parsel's XPath-translated semantics (`descendant-or-self::`): the context element itself
 * can match and its ancestors are invisible to the selector, so `el.css("body p")` only matches when `body` is the
 * context element or inside it.
 */
import { compile } from "css-select";
import { parse as parseCss, SelectorType, type Selector as CssToken } from "css-what";

import { Element, ELEMENT_NODE, TEXT_NODE, CDATA_SECTION_NODE, type Attr, type ChildNode, type Text, Document } from "./nodes.js";

export class SelectorSyntaxError extends Error {
  override name = "SelectorSyntaxError";
}

type AnyNode = ChildNode | Document;
let scopeRoot: Element | null = null;

interface Adapter<N, E extends N> {
  isTag: (node: N) => node is E;
  getAttributeValue: (element: E, name: string) => string | undefined;
  getChildren: (node: N) => N[];
  getName: (element: E) => string;
  getParent: (node: E) => N | null;
  getSiblings: (node: N) => N[];
  prevElementSibling?: (node: N) => E | null;
  getText: (node: N) => string;
  hasAttrib: (element: E, name: string) => boolean;
  removeSubsets: (nodes: N[]) => N[];
}

const adapter: Adapter<AnyNode, Element> = {
  isTag: (node): node is Element => node.nodeType === ELEMENT_NODE,
  getAttributeValue: (element, name) => element.getAttribute(name) ?? undefined,
  getChildren: (node) => (node as Element).childNodes ?? [],
  getName: (element) => element.tagName,
  getParent: (node) => (node === scopeRoot ? null : (node.parentNode as AnyNode | null)),
  getSiblings: (node) => {
    const parent = node.parentNode;
    return parent ? parent.childNodes : [node];
  },
  prevElementSibling: (node) => {
    let prev = (node as ChildNode).previousSibling;
    while (prev && prev.nodeType !== ELEMENT_NODE) prev = prev.previousSibling;
    return prev as Element | null;
  },
  getText: (node) => {
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) return (node as Text).data;
    return (node as Element).textContent ?? "";
  },
  hasAttrib: (element, name) => element.hasAttribute(name),
  removeSubsets: (nodes) => {
    const set = new Set(nodes);
    return nodes.filter((node) => {
      let parent = node.parentNode as AnyNode | null;
      while (parent) {
        if (set.has(parent)) return false;
        parent = parent.parentNode as AnyNode | null;
      }
      return true;
    });
  },
};

export type PseudoElement = { kind: "text" } | { kind: "attr"; name: string } | null;

interface CompiledGroup {
  test: (element: Element) => boolean;
  pseudo: PseudoElement;
  source: string;
}

const MAX_CACHE = 256;
// A CSS identifier can't start with a digit (or a hyphen followed by a digit)
const IDENT_RE = /^(?:-?[A-Za-z_\u00A0-\uFFFF\\]|--)[\w\u00A0-\uFFFF\\-]*$/;
const compiledCache = new Map<string, CompiledGroup[]>();

function stringifyGroup(tokens: CssToken[]): string {
  // css-what's own `stringify` is enough to give us a readable canonical form for each group
  return tokensToString(tokens);
}

function tokensToString(tokens: CssToken[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "tag":
        out += token.name;
        break;
      case "universal":
        out += "*";
        break;
      case "attribute":
        if (token.name === "class" && token.action === "element") out += `.${token.value}`;
        else if (token.name === "id" && token.action === "equals" && token.ignoreCase !== true) out += `#${token.value}`;
        else {
          const ops: Record<string, string> = {
            exists: "",
            equals: "=",
            element: "~=",
            start: "^=",
            end: "$=",
            any: "*=",
            not: "!=",
            hyphen: "|=",
          };
          out +=
            token.action === "exists"
              ? `[${token.name}]`
              : `[${token.name}${ops[token.action]}${JSON.stringify(token.value)}${token.ignoreCase === true ? " i" : ""}]`;
        }
        break;
      case "pseudo":
        if (token.data === null) out += `:${token.name}`;
        else if (typeof token.data === "string") out += `:${token.name}(${token.data})`;
        else out += `:${token.name}(${token.data.map(tokensToString).join(", ")})`;
        break;
      case "pseudo-element":
        out += token.data ? `::${token.name}(${token.data})` : `::${token.name}`;
        break;
      case "descendant":
        out += " ";
        break;
      case "child":
        out += " > ";
        break;
      case "sibling":
        out += " ~ ";
        break;
      case "adjacent":
        out += " + ";
        break;
      default:
        out += "";
    }
  }
  return out.trim();
}

/** Parse and compile a selector list, splitting it to groups and extracting trailing pseudo-elements */
export function compileSelector(selector: string): CompiledGroup[] {
  const cached = compiledCache.get(selector);
  if (cached) return cached;

  let groups: CssToken[][];
  try {
    groups = parseCss(selector);
  } catch (e) {
    throw new SelectorSyntaxError(`Invalid CSS selector '${selector}': ${(e as Error).message}`);
  }

  const compiled: CompiledGroup[] = groups.map((group) => {
    let pseudo: PseudoElement = null;
    const tokens = [...group];
    const last = tokens[tokens.length - 1];
    if (last && last.type === "pseudo-element") {
      tokens.pop();
      if (last.name === "text") pseudo = { kind: "text" };
      else if (last.name === "attr") {
        const name = (last.data ?? "").trim().replace(/^["']|["']$/g, "");
        if (!name) throw new SelectorSyntaxError(`Expected a single string or ident for ::attr(), got '${last.data}'`);
        pseudo = { kind: "attr", name };
      } else {
        throw new SelectorSyntaxError(`The pseudo-element ::${last.name} is unknown`);
      }
    }
    for (const token of tokens) {
      if (token.type === "tag" && !IDENT_RE.test(token.name)) {
        throw new SelectorSyntaxError(`Invalid CSS selector '${selector}': unexpected '${token.name}'`);
      }
      if (token.type === "pseudo-element") {
        throw new SelectorSyntaxError(`Pseudo-elements must be at the end of the selector: '${selector}'`);
      }
    }
    if (tokens.length === 0 || (tokens[tokens.length - 1]!.type !== "tag" && isCombinator(tokens[tokens.length - 1]!))) {
      tokens.push({ type: SelectorType.Universal, namespace: null });
    }
    let test: (element: Element) => boolean;
    try {
      test = compile<AnyNode, Element>([tokens], { adapter, xmlMode: false, cacheResults: false }) as (
        element: Element,
      ) => boolean;
    } catch (e) {
      throw new SelectorSyntaxError(`Invalid CSS selector '${selector}': ${(e as Error).message}`);
    }
    return { test, pseudo, source: stringifyGroup(group) };
  });

  if (compiledCache.size >= MAX_CACHE) compiledCache.delete(compiledCache.keys().next().value!);
  compiledCache.set(selector, compiled);
  return compiled;
}

function isCombinator(token: CssToken): boolean {
  return token.type === "descendant" || token.type === "child" || token.type === "sibling" || token.type === "adjacent";
}

/** Split a selector list into its canonical single selectors */
export function splitSelectors(selector: string): string[] {
  return compileSelector(selector).map((group) => group.source);
}

export type CssResult = Element | Text | Attr;

function applyPseudo(element: Element, pseudo: PseudoElement, out: CssResult[]): void {
  if (!pseudo) {
    out.push(element);
  } else if (pseudo.kind === "text") {
    for (const child of element.childNodes) {
      if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) out.push(child as Text);
    }
  } else {
    const attr = element.getAttributeNode(pseudo.name);
    if (attr) out.push(attr);
  }
}

/** Run a CSS selector against the context element, `descendant-or-self` style */
export function cssSelect(selector: string, context: Element): CssResult[] {
  const groups = compileSelector(selector);
  const previousScope = scopeRoot;
  scopeRoot = context;
  try {
    if (groups.length === 1) {
      const { test, pseudo } = groups[0]!;
      const out: CssResult[] = [];
      if (test(context)) applyPseudo(context, pseudo, out);
      for (const element of context.descendantElements()) if (test(element)) applyPseudo(element, pseudo, out);
      return out;
    }

    // A union of several selectors comes back in document order without duplicates, like XPath's `|`
    const found = new Set<CssResult>();
    const visit = (element: Element) => {
      for (const { test, pseudo } of groups) {
        if (test(element)) {
          const out: CssResult[] = [];
          applyPseudo(element, pseudo, out);
          for (const item of out) found.add(item);
        }
      }
    };
    visit(context);
    for (const element of context.descendantElements()) visit(element);
    return [...found].sort((a, b) => a._order - b._order);
  } finally {
    scopeRoot = previousScope;
  }
}

/** Check if an element matches a CSS selector (pseudo-elements are ignored) */
export function cssMatches(selector: string, element: Element): boolean {
  const groups = compileSelector(selector);
  const previousScope = scopeRoot;
  scopeRoot = null;
  try {
    return groups.some(({ test }) => test(element));
  } finally {
    scopeRoot = previousScope;
  }
}

export { Element };
