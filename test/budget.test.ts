import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { render, BudgetExceededError, DEFAULT_MAX_STEPS } from "../src/index";

describe("step budget", () => {
  it("counts loop iterations", () => {
    const tpl = "{% for i in items %}{{ i }}{% endfor %}";
    const items = [1, 2, 3];
    assert.equal(render(tpl, { items }, { maxSteps: 3 }), "123");
    assert.throws(() => render(tpl, { items }, { maxSteps: 2 }), BudgetExceededError);
  });

  it("counts filter applications", () => {
    const tpl = '{{ "x" | upper | lower }}';
    assert.equal(render(tpl, {}, { maxSteps: 2 }), "x");
    assert.throws(() => render(tpl, {}, { maxSteps: 1 }), BudgetExceededError);
  });

  it("shares the budget between loops and filters", () => {
    const tpl = "{% for i in items %}{{ i | upper }}{% endfor %}";
    const items = ["a", "b"];
    assert.equal(render(tpl, { items }, { maxSteps: 4 }), "AB");
    assert.throws(() => render(tpl, { items }, { maxSteps: 3 }), BudgetExceededError);
  });

  it("enforces the default budget", () => {
    const items = Array.from({ length: DEFAULT_MAX_STEPS + 1 }, (_, i) => i);
    assert.throws(
      () => render("{% for i in items %}{{ i }}{% endfor %}", { items }),
      BudgetExceededError
    );
  });

  it("rejects invalid maxSteps", () => {
    assert.throws(() => render("x", {}, { maxSteps: -1 }), /non-negative integer/);
    assert.throws(() => render("x", {}, { maxSteps: 1.5 }), /non-negative integer/);
  });
});
