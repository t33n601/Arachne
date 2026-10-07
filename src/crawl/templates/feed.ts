import { parse as parseCsv } from "csv-parse/sync";

import { parseXML, stripNamespaces, XMLSyntaxError } from "../../dom/xml.js";
import { Document, type Element } from "../../dom/nodes.js";
import type { Response } from "../../transport/utils/response.js";
import { Node } from "../../parser.js";
import { iterateCallback, type CallbackResult } from "../request.js";
import { Crawler } from "../crawler.js";
import { decompress } from "./utils.js";

type NodeOutput = AsyncIterable<CallbackResult> | Iterable<CallbackResult> | Promise<CallbackResult | Iterable<CallbackResult> | void> | CallbackResult | void;

/**
 * A crawler that iterates over the nodes of an XML feed (RSS, Atom, product feeds...). Override `parseNode()` to process
 * each node matching `itertag`. Gzipped feeds are decompressed automatically.
 *
 * Each node is passed as a `Node` over a namespace-stripped copy of the element, so `node.css("title::text")` and
 * `node.xpath("./link/text()")` work on any feed without namespace maps.
 */
export abstract class XmlFeedCrawler extends Crawler {
  /** The node name to iterate over. A plain name matches any namespace, a prefixed one (`media:content`) only its own */
  itertag = "item";
  /** `[prefix, uri]` pairs defining the prefixes usable in `itertag` */
  namespaces: [string, string][] = [];

  async *parse(response: Response): AsyncGenerator<CallbackResult> {
    let body: Uint8Array;
    try {
      body = decompress(response.body, response.header("content-type"));
    } catch (e) {
      this.logger.warning(`Failed to decompress feed: ${(e as Error).message}`);
      return;
    }
    let doc: Document;
    try {
      doc = parseXML(new TextDecoder("utf-8").decode(body));
    } catch (e) {
      if (!(e instanceof XMLSyntaxError)) throw e;
      this.logger.warning(`Failed to parse XML feed from ${response.url}: ${e.message}`);
      return;
    }
    for (const node of this.iterNodes(doc)) {
      yield* iterateCallback(this.parseNode(response, node));
    }
  }

  /** Override to process one feed node */
  abstract parseNode(response: Response, node: Node): NodeOutput;

  /** Resolve `itertag` into a `[namespace uri or null, local name]` pair */
  protected wantedTag(): [string | null, string] {
    const idx = this.itertag.lastIndexOf(":");
    if (idx === -1) return [null, this.itertag];
    const prefix = this.itertag.slice(0, idx);
    const uri = new Map(this.namespaces).get(prefix);
    if (!uri) throw new Error(`\`itertag\` prefix ${JSON.stringify(prefix)} is not defined in \`namespaces\``);
    return [uri, this.itertag.slice(idx + 1)];
  }

  protected *iterNodes(doc: Document): Generator<Node> {
    const [uri, name] = this.wantedTag();
    for (const element of doc.descendantElements()) {
      if (element.localName === name && (uri === null || element.namespaceURI === uri)) {
        yield XmlFeedCrawler.toSelector(stripNamespaces(element));
      }
    }
  }

  protected static toSelector(element: Element): Node {
    const doc = new Document();
    doc.appendChild(element);
    doc.reindex();
    return new Node(null, { root: element });
  }
}

/**
 * A crawler that iterates over the rows of a CSV feed. Override `parseRow()` to process each row as an object.
 * Gzipped feeds are decompressed automatically.
 */
export abstract class CsvFeedCrawler extends Crawler {
  delimiter = ",";
  quotechar = '"';
  /** The column names, the first row of the feed is used when left unset */
  headers: string[] | null = null;

  async *parse(response: Response): AsyncGenerator<CallbackResult> {
    let body: Uint8Array;
    try {
      body = decompress(response.body, response.header("content-type"));
    } catch (e) {
      this.logger.warning(`Failed to decompress feed: ${(e as Error).message}`);
      return;
    }
    let text: string;
    try {
      text = new TextDecoder(response.encoding || "utf-8").decode(body);
    } catch {
      text = new TextDecoder("utf-8").decode(body);
    }
    const rows = parseCsv(text, {
      columns: this.headers ?? true,
      delimiter: this.delimiter,
      quote: this.quotechar,
      relax_column_count: true,
      skip_empty_lines: true,
      bom: true,
    }) as Record<string, string>[];
    for (const row of rows) yield* iterateCallback(this.parseRow(response, { ...row }));
  }

  /** Override to process one feed row as a `{column: value}` object */
  abstract parseRow(response: Response, row: Record<string, string>): NodeOutput;
}
