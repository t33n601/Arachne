import type { Response } from "../../transport/utils/response.js";
import { Request } from "../request.js";
import type { Item } from "../result.js";
import { Crawler } from "../crawler.js";
import { removeTags } from "../url-utils.js";

interface ShopifyVariant {
  id: number;
  title: string;
  price: string;
  sku?: string | null;
  available?: boolean;
  compare_at_price?: string | null;
  barcode?: string | null;
}

interface ShopifyProduct {
  title: string;
  handle: string;
  vendor: string;
  body_html?: string | null;
  images: { src: string }[];
  variants: ShopifyVariant[];
}

function titleCase(text: string): string {
  return text.replace(/\w\S*/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

/**
 * Extracts all products from any Shopify-powered website through its JSON API. Set `targetWebsite` to the store's domain
 * (or `startUrls`/`allowedDomains`), and the crawler walks `/collections.json`, then each collection's `products.json`,
 * yielding one item per product variant without touching the website's HTML.
 */
export class ShopifyCrawler extends Crawler {
  override name: string | null = "shopify";
  targetWebsite = "";
  collectionsUrl = "https://{website}/collections.json?page={page}&limit=250";
  productsUrl = "https://{website}/collections/{handle}/products.json?page={page}&limit=250";
  productUrl = "https://{website}/collections/{handle}/products/{product_handle}";
  readonly collectedIds = new Set<number>();
  private resolvedWebsite: string | null = null;

  private format(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
  }

  /** The store's domain, resolved from `targetWebsite`, `startUrls`, or `allowedDomains` */
  get website(): string {
    if (this.resolvedWebsite) return this.resolvedWebsite;
    const source = this.targetWebsite || this.startUrls[0] || [...this.allowedDomains][0] || "";
    if (!source) throw new Error(`${this.constructor.name} must set \`targetWebsite\`, \`startUrls\`, or \`allowedDomains\``);
    this.resolvedWebsite = new URL(source.includes("://") ? source : `https://${source}`).host;
    return this.resolvedWebsite;
  }

  protected override ensureInitialized(): void {
    void this.website;
    super.ensureInitialized();
  }

  override async *startRequests(): AsyncGenerator<Request> {
    yield new Request(this.format(this.collectionsUrl, { website: this.website, page: 1 }), { callback: this.parse, meta: { page: 1 } });
  }

  async *parse(response: Response): AsyncGenerator<Request> {
    const collections = response.json<{ collections: { handle: string; products_count: number }[] }>().collections;
    if (!collections?.length) return;
    for (const collection of collections) {
      if (collection.products_count) {
        yield new Request(this.format(this.productsUrl, { website: this.website, handle: collection.handle, page: 1 }), {
          callback: this.parseCollection,
          meta: { handle: collection.handle, page: 1 },
        });
      }
    }
    const nextPage = Number(response.meta.page ?? 1) + 1;
    yield new Request(this.format(this.collectionsUrl, { website: this.website, page: nextPage }), {
      callback: this.parse,
      meta: { page: nextPage },
    });
  }

  protected *processProduct(product: ShopifyProduct, collectionHandle: string): Generator<Item> {
    for (const variant of product.variants) {
      if (this.collectedIds.has(variant.id)) continue;
      this.collectedIds.add(variant.id);
      const oldPrice = variant.compare_at_price;
      yield {
        name: product.title + (variant.title !== "Default Title" ? ` - ${variant.title}` : ""),
        price: variant.price,
        category: titleCase(collectionHandle.replace(/-/g, " ")).trim(),
        brand: product.vendor,
        identifier: variant.id,
        sku: variant.sku || "",
        stock: variant.available ? null : 0,
        image_url: product.images.length ? product.images[0]!.src : "",
        url: this.format(this.productUrl, { website: this.website, handle: collectionHandle, product_handle: product.handle }),
        description: removeTags(product.body_html || ""),
        old_price: oldPrice && Number.parseFloat(oldPrice) ? oldPrice : "",
        barcode: variant.barcode || "",
      };
    }
  }

  async *parseCollection(response: Response): AsyncGenerator<Item | Request> {
    const handle = String(response.meta.handle);
    const page = Number(response.meta.page ?? 1);
    const products = response.json<{ products: ShopifyProduct[] }>().products;
    if (products?.length) {
      for (const product of products) yield* this.processProduct(product, handle);
      yield new Request(this.format(this.productsUrl, { website: this.website, handle, page: page + 1 }), {
        callback: this.parseCollection,
        meta: { handle, page: page + 1 },
      });
    } else {
      this.logger.debug(`Extracted all products from collection ${handle}`);
    }
  }
}
