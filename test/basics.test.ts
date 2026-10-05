import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { render, TemplateError } from "../src/index";

describe("basics", () => {
  it("interpolates own fields", () => {
    assert.equal(render("Hello {{ name }}!", { name: "World" }), "Hello World!");
  });

  it("resolves nested paths and array indices", () => {
    const data = { user: { address: { city: "Shanghai" } }, items: ["a", "b"] };
    assert.equal(render("{{ user.address.city }} {{ items.1 }}", data), "Shanghai b");
  });

  it("renders numbers, booleans and null", () => {
    assert.equal(render("{{ n }}|{{ b }}|{{ z }}", { n: 42, b: true, z: null }), "42|true|");
  });

  it("supports if/else", () => {
    const tpl = "{% if flag %}yes{% else %}no{% endif %}";
    assert.equal(render(tpl, { flag: 1 }), "yes");
    assert.equal(render(tpl, { flag: 0 }), "no");
  });

  it("supports for loops with else branch", () => {
    const tpl = "{% for u in users %}{{ u.name }};{% else %}empty{% endfor %}";
    assert.equal(render(tpl, { users: [{ name: "a" }, { name: "b" }] }), "a;b;");
    assert.equal(render(tpl, { users: [] }), "empty");
  });

  it("supports nested loops and variable shadowing", () => {
    const tpl = "{% for x in rows %}[{% for x in cols %}{{ x }}{% endfor %}]{% endfor %}";
    assert.equal(render(tpl, { rows: [1, 2], cols: ["a", "b"] }), "[ab][ab]");
  });

  it("applies built-in filters", () => {
    assert.equal(render('{{ "hi" | upper }}', {}), "HI");
    assert.equal(render("{{ items | join('-') }}", { items: [1, 2, 3] }), "1-2-3");
    assert.equal(render("{{ missing | default('d') }}", { missing: null }), "d");
    assert.equal(render("{{ s | escape }}", { s: "<a>&" }), "&lt;a&gt;&amp;");
    assert.equal(render("{{ items | length }}", { items: [1, 2] }), "2");
    assert.equal(render("{{ o | json }}", { o: { a: 1 } }), '{"a":1}');
  });

  it("accepts custom filters via options", () => {
    const out = render("{{ n | double }}", { n: 21 }, {
      filters: { double: (v) => Number(v) * 2 },
    });
    assert.equal(out, "42");
  });

  it("rejects unknown filters", () => {
    assert.throws(() => render("{{ 1 | nope }}", {}), /unknown filter "nope"/);
  });

  it("rejects rendering objects without a filter", () => {
    assert.throws(() => render("{{ o }}", { o: {} }), TemplateError);
  });

  it("rejects non-array for-loop sources", () => {
    assert.throws(() => render("{% for x in n %}{% endfor %}", { n: 3 }), /not an array/);
  });
});
