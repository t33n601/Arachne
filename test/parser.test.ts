import { describe, expect, it } from "vitest";

import { Node, NodeList, SelectorSyntaxError } from "../src/parser.js";
import { TextValue } from "../src/core/text.js";

const HTML = `
<html>
<head>
    <title>Complex Web Page</title>
    <style>
        .hidden { display: none; }
    </style>
</head>
<body>
    <header>
        <nav>
            <ul>
                <li><a href="#home">Home</a></li>
                <li><a href="#about">About</a></li>
                <li><a href="#contact">Contact</a></li>
            </ul>
        </nav>
    </header>
    <main>
        <section id="products" schema='{"jsonable": "data"}'>
            <h2>Products</h2>
            <div class="product-list">
                <article class="product" data-id="1">
                    <h3>Product 1</h3>
                    <p class="description">This is product 1</p>
                    <span class="price">$10.99</span>
                    <div class="hidden stock">In stock: 5</div>
                </article>
                <article class="product" data-id="2">
                    <h3>Product 2</h3>
                    <p class="description">This is product 2</p>
                    <span class="price">$20.99</span>
                    <div class="hidden stock">In stock: 3</div>
                </article>
                <article class="product" data-id="3">
                    <h3>Product 3</h3>
                    <p class="description">This is product 3</p>
                    <span class="price">$15.99</span>
                    <div class="hidden stock">Out of stock</div>
                </article>
            </div>
        </section>
        <section id="reviews">
            <h2>Customer Reviews</h2>
            <div class="review-list">
                <div class="review" data-rating="5">
                    <p class="review-text">Great product!</p>
                    <span class="reviewer">John Doe</span>
                </div>
                <div class="review" data-rating="4">
                    <p class="review-text">Good value for money.</p>
                    <span class="reviewer">Jane Smith</span>
                </div>
            </div>
        </section>
    </main>
    <footer>
        <p>&copy; 2024 Our Company</p>
    </footer>
    <script id="page-data" type="application/json">
        {"lastUpdated": "2024-09-22T10:30:00Z", "totalProducts": 3}
    </script>
</body>
</html>
`;

const page = () => new Node(HTML);

describe("CSS selectors", () => {
  it("selects products", () => {
    expect(page().css("main #products .product-list article.product")).toHaveLength(3);
  });

  it("supports :not(:contains())", () => {
    expect(page().css('main #products .product-list article.product:not(:contains("Out of stock"))')).toHaveLength(2);
  });

  it("supports ::text and ::attr()", () => {
    const p = page();
    expect(p.css("nav a::attr(href)").getall().map(String)).toEqual(["#home", "#about", "#contact"]);
    expect(p.css("nav a::text").getall().map(String)).toEqual(["Home", "About", "Contact"]);
    expect(p.css("h3::text, .price::text").getall().map(String)).toEqual([
      "Product 1", "$10.99", "Product 2", "$20.99", "Product 3", "$15.99",
    ]);
  });

  it("scopes selection to the context element like descendant-or-self", () => {
    const list = page().css(".product-list").first!;
    expect(list.css("body article")).toHaveLength(0);
    expect(list.css("div article")).toHaveLength(3);
    expect(list.css(".product-list")).toHaveLength(1);
  });
});

describe("XPath selectors", () => {
  it("selects high rating reviews", () => {
    expect(page().xpath('//section[@id="reviews"]//div[contains(@class, "review") and @data-rating >= 4]')).toHaveLength(2);
  });

  it("selects high priced products", () => {
    const xp =
      '//article[contains(@class, "product")][number(translate(substring-after(.//span[@class="price"], "$"), ",", "")) > 15]';
    expect(page().xpath(xp)).toHaveLength(2);
  });

  it("supports variables and values", () => {
    const p = page();
    expect(p.xpath("//article[@data-id=$id]", { variables: { id: "2" } }).first!.attr("data-id").valueOf()).toBe("2");
    expect(p.xpathValue("count(//article)")).toBe(3);
  });
});

describe("text matching", () => {
  it("finds multiple regex matches", () => {
    expect(page().findByRegex(/In stock: \d+/, { firstMatch: false })).toHaveLength(2);
  });

  it("finds the first regex match", () => {
    expect(page().findByRegex(/In stock: \d+/, { caseSensitive: true })!.text.valueOf()).toBe("In stock: 5");
  });

  it("finds partial and exact text", () => {
    expect(page().findByText("In stock:", { partial: true, firstMatch: false })).toHaveLength(2);
    expect(page().findByText("Out of stock", { firstMatch: false })).toHaveLength(1);
  });
});

describe("similar elements", () => {
  it("finds similar products", () => {
    expect(page().css(".product").first!.findSimilar()).toHaveLength(2);
  });

  it("finds similar reviews", () => {
    const first = page().find("div", { class: "review" })!;
    const similar = first.findSimilar().filter((r) => Number(r.attrib.get("data-rating", "0")) >= 4);
    expect(similar).toHaveLength(1);
  });
});

describe("find by class/attributes", () => {
  it("matches multi class elements", () => {
    const p = page();
    expect(p.findAll("div", { class: "stock" })).toHaveLength(3);
    expect(p.findAll("div", { class: "hidden" })).toHaveLength(3);
    expect(p.findAll("div", { class: "hidden stock" })).toHaveLength(3);
    expect(p.findAll("div", { class: "stock hidden" })).toHaveLength(3);
    expect(p.findAll("div", { class: "hidden nonexistent" })).toHaveLength(0);
  });

  it("keeps filtering on a blank class", () => {
    const s = new Node('<div class="">empty</div><div class="a">a</div><div>none</div>');
    expect(s.findAll("div", { class: "" }).map((e) => e.getAllText().valueOf())).toEqual(["empty"]);
    expect(s.findAll("div", { class: "   " })).toHaveLength(0);
  });

  it("escapes values", () => {
    const s = new Node('<a title=\'say "hi"\'>quoted</a><a title="one\ntwo">broken</a><a title="back\\slash">bs</a>');
    expect(s.find("a", { title: 'say "hi"' })!.getAllText().valueOf()).toBe("quoted");
    expect(s.find("a", { title: "one\ntwo" })!.getAllText().valueOf()).toBe("broken");
    expect(s.find("a", { title: "back\\slash" })!.getAllText().valueOf()).toBe("bs");
  });

  it("supports regex and function filters", () => {
    const p = page();
    expect(p.findAll("div", /In stock/)).toHaveLength(2);
    expect(p.findAll((el: Node) => el.tag === "article")).toHaveLength(3);
    expect(p.findAll(["h3", "h2"])).toHaveLength(5);
  });
});

describe("error handling", () => {
  it("rejects invalid initialization", () => {
    expect(() => new Node()).toThrow(TypeError);
    expect(() => new Node(1 as unknown as string)).toThrow(TypeError);
  });

  it("rejects invalid storage", () => {
    expect(() => new Node(HTML, { track: true, storage: (() => ({})) as never })).toThrow(TypeError);
  });

  it("rejects bad selectors", () => {
    expect(() => page().css("4 ayo")).toThrow(SelectorSyntaxError);
    expect(() => page().xpath("4 ayo")).toThrow(SelectorSyntaxError);
  });
});

describe("navigation", () => {
  it("has basic properties", () => {
    const table = page().css(".product-list")[0]!;
    expect(table.path.length).toBeGreaterThan(0);
    expect(table.htmlContent.length).toBeGreaterThan(0);
    expect(table.prettify().length).toBeGreaterThan(0);
  });

  it("navigates parents, siblings, and children", () => {
    const table = page().css(".product-list")[0]!;
    const parent = table.parent!;
    expect(parent.attr("id").valueOf()).toBe("products");
    expect(parent.siblings).toHaveLength(1);
    expect(table.children).toHaveLength(3);
  });

  it("navigates next and previous", () => {
    const child = page().css(".product-list")[0]!.find({ "data-id": "1" })!;
    const next = child.next!;
    expect(next.attrib.get("data-id")!.valueOf()).toBe("2");
    expect(next.previous!.tag).toBe(child.tag);
  });

  it("finds ancestors", () => {
    const prices = page().css(".price");
    expect(prices.map((price) => price.findAncestor((p) => p.hasClass("product"))).filter(Boolean)).toHaveLength(3);
  });
});

describe("JSON and attributes", () => {
  it("converts content to JSON", () => {
    const script = page().css("#page-data::text")[0]!.get();
    expect(script.sort()).toBeInstanceOf(TextValue);
    const data = script.json();
    expect(data.totalProducts).toBe(3);
    expect(data).toHaveProperty("lastUpdated");
  });

  it("handles attributes", () => {
    const p = page();
    const products = p.css(".product");
    expect(products.map((product) => product.attrib.get("data-id")!.valueOf())).toEqual(["1", "2", "3"]);
    expect(products[0]!.hasAttr("data-id")).toBe(true);
    const reviews = p.css(".review").map((review) => Number(review.attr("data-rating")));
    expect(reviews.reduce((a, b) => a + b, 0) / reviews.length).toBe(4.5);
    expect([...[...products[0]!.attrib.searchValues("1")][0]!.keys()]).toEqual(["data-id"]);
    expect([...[...products[0]!.attrib.searchValues("1", true)][0]!.keys()]).toEqual(["data-id"]);
    expect(p.css("#products").first!.attr("schema").json()).toEqual({ jsonable: "data" });
    expect(typeof p.css("#products")[0]!.attrib.jsonString).toBe("string");
  });
});

describe("selectors generation", () => {
  it("generates selectors for every element", () => {
    const traverse = (element: Node) => {
      expect(typeof element.generateCssSelector).toBe("string");
      expect(typeof element.generateFullCssSelector).toBe("string");
      expect(typeof element.generateXpathSelector).toBe("string");
      expect(typeof element.generateFullXpathSelector).toBe("string");
      for (const child of element.children) traverse(child);
    };
    traverse(page());
  });

  it("generated selectors select the right element", () => {
    const p = page();
    for (const element of p.css("article, span, li, a, h2")) {
      for (const css of [element.generateCssSelector, element.generateFullCssSelector]) {
        const found = p.css(css);
        expect(found).toHaveLength(1);
        expect(found[0]!._root).toBe(element._root);
      }
      for (const xp of [element.generateXpathSelector, element.generateFullXpathSelector]) {
        const found = p.xpath(xp);
        expect(found).toHaveLength(1);
        expect(found[0]!._root).toBe(element._root);
      }
    }
  });

  it("doesn't duplicate ids in full paths", () => {
    const s = new Node('<html><body><div id="main"><p id="target">Hello</p></div></body></html>');
    const target = s.css("#target").first!;
    const cssFull = target.generateFullCssSelector;
    expect(cssFull.split("#target").length - 1).toBe(1);
    expect(cssFull.split("#main").length - 1).toBe(1);
    expect(s.css(cssFull).first!.text.valueOf()).toBe("Hello");
    const xpathFull = target.generateFullXpathSelector;
    expect(s.xpath(xpathFull)).toHaveLength(1);
    expect(s.xpath(xpathFull).first!.text.valueOf()).toBe("Hello");
  });
});

describe("misc", () => {
  it("gets all text", () => {
    const text = page().getAllText({ strip: true }).valueOf();
    expect(text).toContain("Product 1");
    expect(text).not.toContain(".hidden");
  });

  it("applies regex on text", () => {
    const element = page().css('[data-id="1"] .price')[0]!;
    expect(element.reFirst(/[.\d]+/)!.valueOf()).toBe("10.99");
    expect(element.text.re(/(\d+)/, { replaceEntities: false })).toHaveLength(2);
  });

  it("decodes entities and keeps text semantics", () => {
    const p = page();
    expect(p.css("footer p::text").get()!.valueOf()).toBe("© 2024 Our Company");
    const s = new Node("<p>Hello <b>bold</b> tail<!-- c -->end</p>");
    expect(s.css("p").first!.text.valueOf()).toBe("Hello ");
    expect(s.css("p::text").getall().map(String)).toEqual(["Hello ", " tailend"]);
  });

  it("is fast on big documents", () => {
    const big = `<html><body>${'<div class="item">'.repeat(5000)}${"</div>".repeat(5000)}</body></html>`;
    const start = performance.now();
    const parsed = new Node(big);
    const items = parsed.css(".item");
    expect(items).toHaveLength(5000);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("returns NodeList from list helpers", () => {
    const products = page().css(".product");
    expect(products.filter(() => true)).toBeInstanceOf(NodeList);
    expect(products.slice(1)).toBeInstanceOf(NodeList);
    expect(products.css(".price::text").getall().map(String)).toEqual(["$10.99", "$20.99", "$15.99"]);
    expect(products.reFirst(/Product (\d)/)).toBeNull();
    expect(products.css("h3").reFirst(/Product (\d)/)!.valueOf()).toBe("1");
    expect(products.search((p) => p.attr("data-id").valueOf() === "2")!.attr("data-id").valueOf()).toBe("2");
  });
});
