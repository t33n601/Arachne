import { describe, expect, it } from "vitest";

import { Node } from "../src/parser.js";
import { similarity } from "../src/core/sequence-matcher.js";

const ORIGINAL = `
<div class="container">
    <section class="products">
        <article class="product" id="p1">
            <h3>Product 1</h3>
            <p class="description">Description 1</p>
        </article>
        <article class="product" id="p2">
            <h3>Product 2</h3>
            <p class="description">Description 2</p>
        </article>
    </section>
</div>`;

const CHANGED = `
<div class="new-container">
    <div class="product-wrapper">
        <section class="products">
            <article class="product new-class" data-id="p1">
                <div class="product-info">
                    <h3>Product 1</h3>
                    <p class="new-description">Description 1</p>
                </div>
            </article>
            <article class="product new-class" data-id="p2">
                <div class="product-info">
                    <h3>Product 2</h3>
                    <p class="new-description">Description 2</p>
                </div>
            </article>
        </section>
    </div>
</div>`;

describe("SequenceMatcher port", () => {
  it("matches Python's difflib ratios", () => {
    const cases: [string | string[], string | string[], number][] = [
      ["abcd", "bcde", 0.75],
      ["Product 1", "Product 2", 0.888889],
      [["html", "body", "div", "section", "article"], ["html", "body", "div", "div", "section", "article"], 0.909091],
      ["", "", 1.0],
      ["a".repeat(250) + "b", "a".repeat(240) + "bc", 0.977688],
      ["private Thread currentThread;", "private volatile Thread currentThread;", 0.865672],
    ];
    for (const [a, b, expected] of cases) expect(similarity(a, b)).toBeCloseTo(expected, 5);
  });
});

describe("tracking", () => {
  it("relocates an element after the structure changed", () => {
    const oldPage = new Node(ORIGINAL, { url: "example.com", track: true });
    const newPage = new Node(CHANGED, { url: "example.com", track: true });

    // 'p1' was used as ID and now it's not, and all the path elements changed
    expect(oldPage.css("#p1, #p2", { saveTrack: true })[0]).toBeDefined();
    const relocated = newPage.css("#p1", { track: true });

    expect(relocated.length).toBeGreaterThan(0);
    expect(relocated[0]!.attr("data-id").valueOf()).toBe("p1");
    expect(relocated[0]!.hasClass("new-class")).toBe(true);
    expect(relocated[0]!.css(".new-description")[0]!.text.valueOf()).toBe("Description 1");
  });

  it("doesn't crash when nothing clears the threshold", () => {
    const oldPage = new Node(
      `<div class="container"><article class="product" id="target"><h3>Widget</h3><p class="desc">A widget</p></article></div>`,
      { url: "example.com", track: true },
    );
    const newPage = new Node("<html><body><span>totally unrelated content</span></body></html>", {
      url: "example.com",
      track: true,
    });
    oldPage.css("#target", { identifier: "target", saveTrack: true });
    const result = newPage.css("#target", { identifier: "target", track: true, saveTrack: true, threshold: 95 });
    expect([...result]).toEqual([]);
  });

  it("works with XPath and manual save/retrieve", () => {
    const oldPage = new Node(ORIGINAL, { url: "https://shop.example.com/a", track: true });
    const element = oldPage.xpath("//article[@id='p2']").first!;
    oldPage.save(element, "second-product");
    expect(oldPage.retrieve("second-product")!.attributes).toEqual({ class: "product", id: "p2" });

    const newPage = new Node(CHANGED, { url: "https://www.example.com/b", track: true });
    const relocated = newPage.xpath("//article[@id='p2']", { identifier: "second-product", track: true });
    expect(relocated.first!.attr("data-id").valueOf()).toBe("p2");
  });

  it("refuses tracking calls when disabled", () => {
    const page = new Node(ORIGINAL);
    expect(() => page.save(page.css("#p1").first!, "x")).toThrow();
    expect(() => page.retrieve("x")).toThrow();
  });
});
