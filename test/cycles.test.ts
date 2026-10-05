import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { render, CycleError } from "../src/index";

describe("object cycles", () => {
  it("detects cycles during path resolution", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    assert.throws(() => render("{{ a.self.self.name }}", { a }), CycleError);
  });

  it("detects cycles in the json filter", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    assert.throws(() => render("{{ a | json }}", { a }), CycleError);
  });

  it("detects array cycles in the json filter", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    assert.throws(() => render("{{ arr | json }}", { arr }), CycleError);
  });

  it("allows shared non-cyclic references", () => {
    const shared = { x: 1 };
    const data = { p: shared, q: shared };
    assert.equal(render("{{ data | json }}", { data }), '{"p":{"x":1},"q":{"x":1}}');
  });

  it("allows repeated loops over the same array", () => {
    const items = [1, 2];
    const tpl = "{% for i in items %}{{ i }}{% endfor %}{% for i in items %}{{ i }}{% endfor %}";
    assert.equal(render(tpl, { items }), "1212");
  });
});
