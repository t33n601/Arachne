/**
 * HTML parsing into our DOM through parse5 (the same HTML5 algorithm browsers use).
 *
 * After parsing, whitespace-only text nodes are dropped following libxml2's `remove_blank_text` rules, so
 * element texts match what lxml-based scrapers return.
 */
import { parse as parse5Parse, type TreeAdapter, type TreeAdapterTypeMap, type Token, html as p5html } from "parse5";

import {
  Comment,
  Document,
  DocumentFragment,
  DocumentType,
  Element,
  Text,
  COMMENT_NODE,
  ELEMENT_NODE,
  TEXT_NODE,
  type ChildNode,
  type ParentNode,
  Attr,
} from "./nodes.js";

type AdapterMap = TreeAdapterTypeMap<
  ChildNode | Document | DocumentFragment,
  ParentNode | DocumentFragment,
  ChildNode,
  Document,
  DocumentFragment,
  Element,
  Comment,
  Text,
  Element,
  DocumentType
>;

export interface HtmlParseOptions {
  /** Keep comment nodes in the tree (dropped by default) */
  keepComments?: boolean;
  /** Drop blank text nodes the same way libxml2 does with `remove_blank_text` (enabled by default) */
  removeBlankText?: boolean;
}

function createAdapter(keepComments: boolean): TreeAdapter<AdapterMap> {
  const appendTo = (parent: ParentNode | DocumentFragment, node: ChildNode) => {
    (parent as Element).appendChild(node);
  };

  return {
    createDocument: () => new Document(),
    createDocumentFragment: () => new DocumentFragment(),
    createElement(tagName: string, _namespaceURI: string, attrs: Token.Attribute[]) {
      const element = new Element(tagName);
      for (const attr of attrs) {
        const node = new Attr(attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name, attr.value);
        node.ownerElement = element;
        element.attributes.push(node);
      }
      return element;
    },
    createCommentNode: (data: string) => new Comment(data),
    createTextNode: (value: string) => new Text(value),
    appendChild(parent, node) {
      if (node.nodeType === COMMENT_NODE && !keepComments) return;
      appendTo(parent, node);
    },
    insertBefore(parent, node, reference) {
      if (node.nodeType === COMMENT_NODE && !keepComments) return;
      (parent as Element).insertBefore(node, reference);
    },
    // Templates' content goes directly inside the element, like lxml does, so it's searchable
    setTemplateContent() {},
    getTemplateContent: (element: Element) => element as unknown as DocumentFragment,
    setDocumentType(document: Document, name: string, publicId: string, systemId: string) {
      for (const child of document.childNodes) {
        if (child instanceof DocumentType) {
          child.name = name;
          child.publicId = publicId;
          child.systemId = systemId;
          return;
        }
      }
      document.insertBefore(new DocumentType(name, publicId, systemId), document.firstChild);
    },
    setDocumentMode(document: Document, mode) {
      document.mode = mode as Document["mode"];
    },
    getDocumentMode: (document: Document) => document.mode as p5html.DOCUMENT_MODE,
    detachNode(node) {
      if (node.parentNode) (node.parentNode as Element).removeChild(node);
    },
    insertText(parent, text) {
      const last = (parent as Element).lastChild;
      if (last && last.nodeType === TEXT_NODE) (last as Text).data += text;
      else appendTo(parent, new Text(text));
    },
    insertTextBefore(parent, text, reference) {
      const prev = reference.previousSibling;
      if (prev && prev.nodeType === TEXT_NODE) (prev as Text).data += text;
      else (parent as Element).insertBefore(new Text(text), reference);
    },
    adoptAttributes(recipient: Element, attrs: Token.Attribute[]) {
      for (const attr of attrs) {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        if (!recipient.hasAttribute(name)) recipient.setAttribute(name, attr.value);
      }
    },
    getFirstChild: (node) => (node as Element).firstChild,
    getChildNodes: (node) => (node as Element).childNodes,
    getParentNode: (node) => node.parentNode as ParentNode | null,
    getAttrList: (element: Element) => element.attributes.map((attr) => ({ name: attr.name, value: attr.value })),
    getTagName: (element: Element) => element.tagName,
    getNamespaceURI: () => p5html.NS.HTML,
    getTextNodeContent: (node: Text) => node.data,
    getCommentNodeContent: (node: Comment) => node.data,
    getDocumentTypeNodeName: (node: DocumentType) => node.name,
    getDocumentTypeNodePublicId: (node: DocumentType) => node.publicId,
    getDocumentTypeNodeSystemId: (node: DocumentType) => node.systemId,
    isTextNode: (node): node is Text => node instanceof Text,
    isCommentNode: (node): node is Comment => node instanceof Comment,
    isDocumentTypeNode: (node): node is DocumentType => node instanceof DocumentType,
    isElementNode: (node): node is Element => node instanceof Element,
    setNodeSourceCodeLocation() {},
    getNodeSourceCodeLocation: () => undefined,
    updateNodeSourceCodeLocation() {},
  };
}

// Tags that libxml2 allows to hold PCDATA, whitespace next to them is meaningful and kept
const ALLOW_PCDATA = new Set([
  "a", "abbr", "acronym", "address", "applet", "b", "bdo", "big", "blockquote", "body", "button", "caption",
  "center", "cite", "code", "dd", "del", "dfn", "div", "dt", "em", "font", "form", "h1", "h2", "h3", "h4", "h5",
  "h6", "i", "iframe", "ins", "kbd", "label", "legend", "li", "map", "menu", "object", "ol", "p", "pre", "q", "s",
  "samp", "small", "span", "strike", "strong", "td", "th", "tt", "u", "ul", "var",
]);
const BLANK_RE = /^[ \t\n\r]*$/;

function removeBlankText(doc: Document): void {
  const blanks: Text[] = [];
  for (const node of doc.descendants()) {
    if (node.nodeType !== TEXT_NODE || !BLANK_RE.test((node as Text).data)) continue;
    const parent = node.parentNode;
    if (!parent || parent.nodeType !== ELEMENT_NODE) {
      blanks.push(node as Text);
      continue;
    }
    const parentTag = (parent as Element).tagName;
    if (parentTag === "html" || parentTag === "head") {
      blanks.push(node as Text);
      continue;
    }
    // Trailing whitespace at the end of the document is dropped too
    if (!node.nextSibling && isLastInDocument(node as Text)) {
      blanks.push(node as Text);
      continue;
    }
    let prev = node.previousSibling;
    while (prev && prev.nodeType === COMMENT_NODE) prev = prev.previousSibling;
    if (!prev) {
      if (!ALLOW_PCDATA.has(parentTag)) blanks.push(node as Text);
    } else if (prev.nodeType === TEXT_NODE) {
      continue;
    } else if (!(prev.nodeType === ELEMENT_NODE && ALLOW_PCDATA.has((prev as Element).tagName))) {
      blanks.push(node as Text);
    }
  }
  for (const node of blanks) (node.parentNode as Element).removeChild(node);
}

function isLastInDocument(node: Text): boolean {
  let current: ChildNode | ParentNode | null = node;
  while (current && current.nodeType !== 9) {
    if (current.nextSibling) return false;
    current = current.parentNode;
  }
  return true;
}

/** Parse an HTML document into our DOM */
export function parseHTML(html: string, options: HtmlParseOptions = {}): Document {
  const adapter = createAdapter(Boolean(options.keepComments));
  const doc = parse5Parse(html, { treeAdapter: adapter, scriptingEnabled: false }) as Document;
  if (options.removeBlankText ?? true) removeBlankText(doc);
  doc.reindex();
  return doc;
}
