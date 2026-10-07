/**
 * A small DOM tailored for scraping. It exposes the standard DOM properties the `xpath` engine walks
 * (nodeType, parentNode, firstChild, nextSibling, attributes, ...) and the hooks `css-select` needs,
 * while staying much lighter than a browser-grade DOM.
 *
 * Every node carries a document-order index, so sorting XPath results doesn't have to walk the tree.
 */

export const ELEMENT_NODE = 1;
export const ATTRIBUTE_NODE = 2;
export const TEXT_NODE = 3;
export const CDATA_SECTION_NODE = 4;
export const PROCESSING_INSTRUCTION_NODE = 7;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_TYPE_NODE = 10;
export const DOCUMENT_FRAGMENT_NODE = 11;

const DOCUMENT_POSITION_PRECEDING = 0x02;
const DOCUMENT_POSITION_FOLLOWING = 0x04;

export type ChildNode = Element | Text | Comment | DocumentType | ProcessingInstruction;
export type ParentNode = Element | Document;

/** Array of attributes that also answers the `NamedNodeMap` calls used by the XPath engine. */
export class NamedNodeMap extends Array<Attr> {
  item(index: number): Attr | null {
    return this[index] ?? null;
  }

  getNamedItem(name: string): Attr | null {
    for (const attr of this) if (attr.name === name) return attr;
    return null;
  }

  static override get [Symbol.species]() {
    return Array;
  }
}

export abstract class DomNode {
  abstract readonly nodeType: number;
  parentNode: ParentNode | null = null;
  previousSibling: ChildNode | null = null;
  nextSibling: ChildNode | null = null;
  ownerDocument: Document | null = null;
  /** Document order index, refreshed by `Document.reindex()` */
  _order = 0;

  get parentElement(): Element | null {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? (this.parentNode as Element) : null;
  }

  get localName(): string | null {
    return null;
  }

  get namespaceURI(): string | null {
    return null;
  }

  get prefix(): string | null {
    return null;
  }

  abstract get nodeName(): string;

  get nodeValue(): string | null {
    return null;
  }

  compareDocumentPosition(other: DomNode): number {
    if (other === this) return 0;
    return other._order < this._order ? DOCUMENT_POSITION_PRECEDING : DOCUMENT_POSITION_FOLLOWING;
  }

  isSameNode(other: DomNode | null): boolean {
    return this === other;
  }
}

export abstract class CharacterData extends DomNode {
  constructor(public data: string) {
    super();
  }

  override get nodeValue(): string {
    return this.data;
  }

  get textContent(): string {
    return this.data;
  }
}

export class Text extends CharacterData {
  readonly nodeType: number = TEXT_NODE;

  get nodeName(): string {
    return "#text";
  }
}

export class CDATASection extends Text {
  override readonly nodeType: number = CDATA_SECTION_NODE;

  override get nodeName(): string {
    return "#cdata-section";
  }
}

export class Comment extends CharacterData {
  readonly nodeType = COMMENT_NODE;

  get nodeName(): string {
    return "#comment";
  }
}

export class ProcessingInstruction extends CharacterData {
  readonly nodeType = PROCESSING_INSTRUCTION_NODE;

  constructor(
    public target: string,
    data: string,
  ) {
    super(data);
  }

  get nodeName(): string {
    return this.target;
  }
}

export class DocumentType extends DomNode {
  readonly nodeType = DOCUMENT_TYPE_NODE;

  constructor(
    public name: string,
    public publicId = "",
    public systemId = "",
  ) {
    super();
  }

  get nodeName(): string {
    return this.name;
  }
}

export class Attr extends DomNode {
  readonly nodeType = ATTRIBUTE_NODE;
  ownerElement: Element | null = null;

  constructor(
    public name: string,
    public value: string,
    private readonly _namespaceURI: string | null = null,
    private readonly _prefix: string | null = null,
  ) {
    super();
  }

  get nodeName(): string {
    return this.name;
  }

  override get localName(): string {
    const idx = this.name.indexOf(":");
    return idx === -1 ? this.name : this.name.slice(idx + 1);
  }

  override get namespaceURI(): string | null {
    return this._namespaceURI;
  }

  override get prefix(): string | null {
    return this._prefix;
  }

  override get nodeValue(): string {
    return this.value;
  }

  get textContent(): string {
    return this.value;
  }

  override compareDocumentPosition(other: DomNode): number {
    if (other === this) return 0;
    return other._order < this._order ? DOCUMENT_POSITION_PRECEDING : DOCUMENT_POSITION_FOLLOWING;
  }
}

abstract class ParentNodeBase extends DomNode {
  readonly childNodes: ChildNode[] = [];

  get firstChild(): ChildNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): ChildNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  /** Child elements only (no text, comments, etc...) */
  get children(): Element[] {
    const result: Element[] = [];
    for (const child of this.childNodes) if (child.nodeType === ELEMENT_NODE) result.push(child as Element);
    return result;
  }

  appendChild<T extends ChildNode>(node: T): T {
    if (node.parentNode) detach(node);
    const last = this.lastChild;
    node.parentNode = this as unknown as ParentNode;
    node.previousSibling = last;
    node.nextSibling = null;
    if (last) last.nextSibling = node;
    this.childNodes.push(node);
    return node;
  }

  insertBefore<T extends ChildNode>(node: T, reference: ChildNode | null): T {
    if (!reference) return this.appendChild(node);
    if (node.parentNode) detach(node);
    const index = this.childNodes.indexOf(reference);
    if (index === -1) throw new Error("The reference node is not a child of this node");
    const prev = reference.previousSibling;
    node.parentNode = this as unknown as ParentNode;
    node.previousSibling = prev;
    node.nextSibling = reference;
    reference.previousSibling = node;
    if (prev) prev.nextSibling = node;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  removeChild<T extends ChildNode>(node: T): T {
    if (node.parentNode !== (this as unknown)) throw new Error("The node is not a child of this node");
    detach(node);
    return node;
  }

  /** Yield every descendant node in document order (this node excluded) */
  *descendants(): Generator<ChildNode> {
    const stack: ChildNode[] = [];
    for (let i = this.childNodes.length - 1; i >= 0; i--) stack.push(this.childNodes[i]!);
    while (stack.length) {
      const node = stack.pop()!;
      yield node;
      if (node.nodeType === ELEMENT_NODE) {
        const kids = (node as Element).childNodes;
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
      }
    }
  }

  /** Yield every descendant element in document order (this node excluded) */
  *descendantElements(): Generator<Element> {
    for (const node of this.descendants()) if (node.nodeType === ELEMENT_NODE) yield node as Element;
  }

  get textContent(): string {
    let text = "";
    for (const node of this.descendants()) {
      if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) text += (node as Text).data;
    }
    return text;
  }
}

export class Element extends ParentNodeBase {
  readonly nodeType = ELEMENT_NODE;
  readonly attributes: NamedNodeMap = new NamedNodeMap();
  /** Content of `<template>` elements as parse5 hands it over */
  content: DocumentFragment | null = null;

  constructor(
    public tagName: string,
    private readonly _namespaceURI: string | null = null,
    private readonly _prefix: string | null = null,
  ) {
    super();
  }

  get nodeName(): string {
    return this.tagName;
  }

  override get localName(): string {
    const idx = this.tagName.indexOf(":");
    return idx === -1 ? this.tagName : this.tagName.slice(idx + 1);
  }

  override get namespaceURI(): string | null {
    return this._namespaceURI;
  }

  override get prefix(): string | null {
    return this._prefix;
  }

  getAttribute(name: string): string | null {
    for (const attr of this.attributes) if (attr.name === name) return attr.value;
    return null;
  }

  getAttributeNode(name: string): Attr | null {
    return this.attributes.getNamedItem(name);
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  setAttribute(name: string, value: string): void {
    const existing = this.attributes.getNamedItem(name);
    if (existing) {
      existing.value = value;
      return;
    }
    const attr = new Attr(name, value);
    attr.ownerElement = this;
    attr.ownerDocument = this.ownerDocument;
    this.attributes.push(attr);
  }

  removeAttribute(name: string): void {
    const index = this.attributes.findIndex((attr) => attr.name === name);
    if (index !== -1) this.attributes.splice(index, 1);
  }

  get classList(): string[] {
    const value = this.getAttribute("class");
    return value ? value.split(/\s+/).filter(Boolean) : [];
  }

  /** Like lxml's `.text`: the text before the first child node, or an empty string */
  get leadingText(): string {
    let text = "";
    for (const child of this.childNodes) {
      if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) text += (child as Text).data;
      else break;
    }
    return text;
  }

  /** Iterate over the ancestors elements, starting with the parent element */
  *ancestors(): Generator<Element> {
    let node = this.parentElement;
    while (node) {
      yield node;
      node = node.parentElement;
    }
  }
}

export class DocumentFragment extends ParentNodeBase {
  readonly nodeType = DOCUMENT_FRAGMENT_NODE;

  get nodeName(): string {
    return "#document-fragment";
  }
}

export class Document extends ParentNodeBase {
  readonly nodeType = DOCUMENT_NODE;
  mode: "no-quirks" | "quirks" | "limited-quirks" = "no-quirks";
  /** Used by the XPath engine to decide if the document is HTML (case insensitive), we never want that */
  readonly implementation = { hasFeature: () => false };

  get nodeName(): string {
    return "#document";
  }

  get documentElement(): Element | null {
    for (const child of this.childNodes) if (child.nodeType === ELEMENT_NODE) return child as Element;
    return null;
  }

  getElementById(id: string): Element | null {
    for (const el of this.descendantElements()) if (el.getAttribute("id") === id) return el;
    return null;
  }

  /** Assign document-order indexes and owner document to every node, attributes included */
  reindex(): void {
    let order = 0;
    this._order = order++;
    for (const node of this.descendants()) {
      node.ownerDocument = this;
      node._order = order++;
      if (node.nodeType === ELEMENT_NODE) {
        for (const attr of (node as Element).attributes) {
          attr.ownerDocument = this;
          attr.ownerElement = node as Element;
          attr._order = order++;
        }
      }
    }
  }
}

function detach(node: ChildNode): void {
  const parent = node.parentNode;
  if (!parent) return;
  const siblings = parent.childNodes;
  const index = siblings.indexOf(node);
  if (index !== -1) siblings.splice(index, 1);
  if (node.previousSibling) node.previousSibling.nextSibling = node.nextSibling;
  if (node.nextSibling) node.nextSibling.previousSibling = node.previousSibling;
  node.parentNode = null;
  node.previousSibling = null;
  node.nextSibling = null;
}

export function isElement(node: unknown): node is Element {
  return node instanceof Element;
}

export function isText(node: unknown): node is Text {
  return node instanceof Text;
}

export function isAttr(node: unknown): node is Attr {
  return node instanceof Attr;
}

/** Deep clone a node into a fresh document so it can be mutated without touching the original tree */
export function cloneIntoDocument(node: Element | Document): Document {
  const doc = new Document();
  if (node instanceof Document) {
    doc.mode = node.mode;
    for (const child of node.childNodes) doc.appendChild(cloneNode(child));
  } else {
    doc.appendChild(cloneNode(node));
  }
  doc.reindex();
  return doc;
}

export function cloneNode<T extends ChildNode>(node: T): T {
  if (node instanceof Element) {
    const copy = new Element(node.tagName, node.namespaceURI, node.prefix);
    for (const attr of node.attributes) {
      const attrCopy = new Attr(attr.name, attr.value, attr.namespaceURI, attr.prefix);
      attrCopy.ownerElement = copy;
      copy.attributes.push(attrCopy);
    }
    for (const child of node.childNodes) copy.appendChild(cloneNode(child));
    return copy as T;
  }
  if (node instanceof CDATASection) return new CDATASection(node.data) as T;
  if (node instanceof Text) return new Text(node.data) as T;
  if (node instanceof Comment) return new Comment(node.data) as T;
  if (node instanceof ProcessingInstruction) return new ProcessingInstruction(node.target, node.data) as T;
  if (node instanceof DocumentType) return new DocumentType(node.name, node.publicId, node.systemId) as T;
  throw new TypeError("Unknown node type");
}
