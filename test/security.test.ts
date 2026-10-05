import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { render, SecurityError, TemplateError } from "../src/index";

describe("security: own-field only access", () => {
  it("allows ordinary own fields", () => {
    assert.equal(render("{{ user.name }}", { user: { name: "amy" } }), "amy");
    assert.equal(render("{{ items.length }}", { items: [1, 2, 3] }), "3");
    assert.equal(render("{{ items.0 }}", { items: ["x"] }), "x");
  });

  it("denies __proto__ even as an own key", () => {
    const data = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    assert.throws(() => render("{{ __proto__ }}", data), SecurityError);
    assert.throws(() => render("{{ __proto__ }}", data), /access to "__proto__" is forbidden/);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("denies constructor and prototype", () => {
    assert.throws(() => render("{{ constructor }}", {}), SecurityError);
    assert.throws(() => render("{{ prototype }}", {}), SecurityError);
    assert.throws(() => render("{{ user.constructor }}", { user: {} }), SecurityError);
    assert.throws(() => render("{{ user.prototype }}", { user: {} }), SecurityError);
  });

  it("denies constructor even as an own data key", () => {
    const data: Record<string, unknown> = {};
    Object.defineProperty(data, "constructor", { value: "fake", enumerable: true });
    assert.throws(() => render("{{ constructor }}", data), SecurityError);
  });

  it("denies prototype-chain properties", () => {
    for (const key of ["toString", "hasOwnProperty", "valueOf", "toLocaleString"]) {
      assert.throws(() => render(`{{ user.${key} }}`, { user: {} }), SecurityError, key);
      assert.throws(
        () => render(`{{ user.${key} }}`, { user: {} }),
        /prototype chain access is forbidden/,
        key
      );
    }
  });

  it("denies array methods inherited from Array.prototype", () => {
    assert.throws(() => render("{{ items.push }}", { items: [1] }), SecurityError);
    assert.throws(() => render("{{ items.map }}", { items: [1] }), SecurityError);
  });

  it("denies methods defined as own function properties", () => {
    assert.throws(() => render("{{ obj.run }}", { obj: { run: () => 1 } }), SecurityError);
  });

  it("never invokes getters", () => {
    let called = false;
    const data: Record<string, unknown> = {};
    Object.defineProperty(data, "trap", {
      get() {
        called = true;
        return "x";
      },
      enumerable: true,
    });
    assert.throws(() => render("{{ trap }}", data), SecurityError);
    assert.equal(called, false);
  });

  it("reports unknown fields separately from prototype hits", () => {
    assert.throws(() => render("{{ user.nope }}", { user: {} }), TemplateError);
    assert.throws(() => render("{{ user.nope }}", { user: {} }), /unknown field "nope"/);
  });

  it("cannot reach globals through constructor chains", () => {
    const tpl = "{{ a.constructor.constructor }}";
    assert.throws(() => render(tpl, { a: "x" }), SecurityError);
    assert.equal(typeof (globalThis as Record<string, unknown>).polluted, "undefined");
  });

  it("does not pollute Object.prototype after malicious input", () => {
    const data = JSON.parse(
      '{"user": {"__proto__": {"isAdmin": true}}, "list": [{"__proto__": {"x": 1}}]}'
    ) as Record<string, unknown>;
    assert.throws(() => render("{{ user.__proto__ }}", data), SecurityError);
    assert.throws(
      () => render("{% for i in list %}{{ i.__proto__ }}{% endfor %}", data),
      SecurityError
    );
    assert.equal(({} as Record<string, unknown>).isAdmin, undefined);
    assert.equal(([] as unknown as Record<string, unknown>).x, undefined);
  });
});
