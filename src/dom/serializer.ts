import {
  CDATASection,
  Comment,
  Document,
  DocumentType,
  Element,
  ProcessingInstruction,
  Text,
  type ChildNode,
} from "./nodes.js";

export const VOID_ELEMENTS = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link",
  "meta", "param", "source", "track", "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr",
  "html", "li", "link", "main", "meta", "nav", "noscript", "ol", "p", "pre", "script", "section", "style", "table",
  "tbody", "td", "tfoot", "th", "thead", "title", "tr", "ul", "br",
]);

export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function serializeAttributes(element: Element): string {
  let out = "";
  for (const attr of element.attributes) out += ` ${attr.name}="${escapeAttribute(attr.value)}"`;
  return out;
}

/** Serialize a node (outer HTML) */
export function serializeHTML(node: ChildNode | Document): string {
  const parts: string[] = [];
  write(node, parts, false);
  return parts.join("");
}

function write(node: ChildNode | Document, out: string[], rawText: boolean): void {
  if (node instanceof Element) {
    const tag = node.tagName;
    out.push(`<${tag}${serializeAttributes(node)}>`);
    if (VOID_ELEMENTS.has(tag)) return;
    const raw = RAW_TEXT_ELEMENTS.has(tag);
    for (const child of node.childNodes) write(child, out, raw);
    out.push(`</${tag}>`);
  } else if (node instanceof CDATASection) {
    out.push(`<![CDATA[${node.data}]]>`);
  } else if (node instanceof Text) {
    out.push(rawText ? node.data : escapeText(node.data));
  } else if (node instanceof Comment) {
    out.push(`<!--${node.data}-->`);
  } else if (node instanceof DocumentType) {
    out.push(`<!DOCTYPE ${node.name || "html"}>`);
  } else if (node instanceof ProcessingInstruction) {
    out.push(`<?${node.target} ${node.data}?>`);
  } else if (node instanceof Document) {
    for (const child of node.childNodes) write(child, out, false);
  }
}

/** Serialize a node with indentation for block level elements */
export function prettifyHTML(node: ChildNode | Document, indentUnit = "  "): string {
  const lines: string[] = [];
  pretty(node, 0, lines, indentUnit);
  return lines.join("\n");
}

function hasOnlyInlineContent(element: Element): boolean {
  for (const child of element.childNodes) {
    if (child instanceof Element && BLOCK_ELEMENTS.has(child.tagName)) return false;
  }
  return true;
}

function pretty(node: ChildNode | Document, depth: number, lines: string[], unit: string): void {
  const indent = unit.repeat(depth);
  if (node instanceof Document) {
    for (const child of node.childNodes) pretty(child, depth, lines, unit);
    return;
  }
  if (!(node instanceof Element)) {
    if (node instanceof Text && !node.data.trim()) return;
    const text = node instanceof Text ? node.data.trim() : serializeHTML(node);
    if (node instanceof Text && node.parentNode instanceof Element && RAW_TEXT_ELEMENTS.has(node.parentNode.tagName)) {
      lines.push(indent + node.data.trim());
    } else {
      lines.push(indent + (node instanceof Text ? escapeText(text) : text));
    }
    return;
  }

  const tag = node.tagName;
  const open = `<${tag}${serializeAttributes(node)}>`;
  if (VOID_ELEMENTS.has(tag)) {
    lines.push(indent + open);
    return;
  }
  if (tag === "pre" || tag === "textarea" || hasOnlyInlineContent(node)) {
    lines.push(indent + serializeHTML(node));
    return;
  }
  lines.push(indent + open);
  for (const child of node.childNodes) pretty(child, depth + 1, lines, unit);
  lines.push(`${indent}</${tag}>`);
}
