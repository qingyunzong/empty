import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { render, tryRender, TemplateError, BudgetExceededError } from "../src/index";

describe("atomic output", () => {
  it("throws instead of returning partial text on runtime errors", () => {
    const tpl = "before {{ user.name }} middle {{ missing.field }} after";
    assert.throws(() => render(tpl, { user: { name: "amy" } }), TemplateError);
    const result = tryRender(tpl, { user: { name: "amy" } });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(!("output" in result), "failure result must not carry output");
      assert.match(result.error.message, /unknown field "missing"/);
    }
  });

  it("returns nothing partial when the budget breaks mid-loop", () => {
    const tpl = "head {% for i in items %}{{ i }} {% endfor %} tail";
    const result = tryRender(tpl, { items: [1, 2, 3] }, { maxSteps: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof BudgetExceededError);
      assert.ok(!("output" in result));
    }
  });

  it("tryRender returns full output on success", () => {
    const result = tryRender("a {{ x }} c", { x: "b" });
    assert.deepEqual(result, { ok: true, output: "a b c" });
  });

  it("stays usable after a failed render", () => {
    const tpl = "{% for i in items %}{{ i }}{% endfor %}";
    assert.throws(() => render(tpl, { items: [1, 2] }, { maxSteps: 1 }));
    assert.equal(render(tpl, { items: [1, 2] }, { maxSteps: 2 }), "12");
  });
});
