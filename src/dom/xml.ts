/** Strict, namespace-aware XML parsing into our DOM (used for sitemaps and feeds). */
import { SaxesParser } from "saxes";

import { Attr, CDATASection, Comment, Document, Element, ProcessingInstruction, Text } from "./nodes.js";

export class XMLSyntaxError extends Error {
  override name = "XMLSyntaxError";
}

/** An element that remembers the namespace it was declared in */
export class NamespacedElement extends Element {
  constructor(
    tagName: string,
    private readonly ns: string | null,
    private readonly nsPrefix: string | null,
    private readonly local: string,
  ) {
    super(tagName, ns, nsPrefix);
  }

  override get namespaceURI(): string | null {
    return this.ns;
  }

  override get prefix(): string | null {
    return this.nsPrefix;
  }

  override get localName(): string {
    return this.local;
  }
}

export function parseXML(xml: string): Document {
  const doc = new Document();
  const stack: (Element | Document)[] = [doc];
  const parser = new SaxesParser({ xmlns: true, position: false });
  const top = () => stack[stack.length - 1]!;

  parser.on("error", (err) => {
    throw new XMLSyntaxError(err.message);
  });
  parser.on("opentag", (tag) => {
    const element = new NamespacedElement(tag.name, tag.uri || null, tag.prefix || null, tag.local);
    for (const attr of Object.values(tag.attributes)) {
      const node = new Attr(attr.name, attr.value, attr.uri || null, attr.prefix || null);
      node.ownerElement = element;
      element.attributes.push(node);
    }
    (top() as Element).appendChild(element);
    stack.push(element);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", (text) => {
    const parent = top();
    if (parent === doc) return;
    const last = (parent as Element).lastChild;
    if (last instanceof Text && !(last instanceof CDATASection)) last.data += text;
    else (parent as Element).appendChild(new Text(text));
  });
  parser.on("cdata", (data) => {
    const parent = top();
    if (parent !== doc) (parent as Element).appendChild(new CDATASection(data));
  });
  parser.on("comment", (data) => {
    (top() as Element).appendChild(new Comment(data));
  });
  parser.on("processinginstruction", (pi) => {
    if (top() !== doc) (top() as Element).appendChild(new ProcessingInstruction(pi.target, pi.body));
  });

  try {
    parser.write(xml.replace(/^﻿/, "")).close();
  } catch (e) {
    if (e instanceof XMLSyntaxError) throw e;
    throw new XMLSyntaxError((e as Error).message);
  }
  if (!doc.documentElement) throw new XMLSyntaxError("Document is empty");
  doc.reindex();
  return doc;
}

/** Return a deep copy of the element with every namespace stripped from tags and attributes */
export function stripNamespaces(element: Element): Element {
  const copy = new Element(element.localName);
  for (const attr of element.attributes) {
    if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) continue;
    const node = new Attr(attr.localName, attr.value);
    node.ownerElement = copy;
    copy.attributes.push(node);
  }
  for (const child of element.childNodes) {
    if (child instanceof Element) copy.appendChild(stripNamespaces(child));
    else if (child instanceof CDATASection) copy.appendChild(new Text(child.data));
    else if (child instanceof Text) copy.appendChild(new Text(child.data));
  }
  return copy;
}
