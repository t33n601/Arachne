/** XPath 1.0 evaluation over our DOM through the `xpath` package. */
import xpathLib from "xpath";

import { SelectorSyntaxError } from "./css.js";
import type { Attr, ChildNode, Document, Element, Text } from "./nodes.js";

export type XPathValue = string | number | boolean;
export type XPathResult = (Element | Text | Attr)[] | XPathValue;
export type XPathVariables = Record<string, XPathValue>;

interface XPathRawResult {
  constructor: { name: string };
  toArray?: () => unknown[];
  stringValue(): string;
  numberValue(): number;
  booleanValue(): boolean;
}

interface ParsedExpression {
  evaluate(options: Record<string, unknown>): XPathRawResult;
}

const MAX_CACHE = 256;
const cache = new Map<string, ParsedExpression>();

function parseExpression(expression: string): ParsedExpression {
  let parsed = cache.get(expression);
  if (parsed) return parsed;
  try {
    parsed = (xpathLib as unknown as { parse(e: string): ParsedExpression }).parse(expression);
  } catch (e) {
    throw new SelectorSyntaxError(`Invalid XPath selector: ${expression} (${(e as Error).message})`);
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(expression, parsed);
  return parsed;
}

/** Evaluate an XPath expression with the given node as the context node */
export function xpathSelect(
  expression: string,
  context: Element | Document | ChildNode,
  variables: XPathVariables = {},
  namespaces: Record<string, string> = {},
): XPathResult {
  const parsed = parseExpression(expression);
  try {
    const result = parsed.evaluate({ node: context, variables, namespaces, isHtml: false });
    if (typeof result.toArray === "function") return result.toArray() as XPathResult;
    switch (result.constructor.name) {
      case "XNumber":
        return result.numberValue();
      case "XBoolean":
        return result.booleanValue();
      default:
        return result.stringValue();
    }
  } catch (e) {
    throw new SelectorSyntaxError(`Invalid XPath selector: ${expression} (${(e as Error).message})`);
  }
}

/** Evaluate an XPath expression that must return a node-set */
export function xpathNodes(
  expression: string,
  context: Element | Document | ChildNode,
  variables?: XPathVariables,
): (Element | Text | Attr)[] {
  const result = xpathSelect(expression, context, variables);
  return Array.isArray(result) ? result : [];
}
