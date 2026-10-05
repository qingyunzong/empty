import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  render,
  tryRender,
  BudgetExceededError,
  CycleError,
  SecurityError,
  TemplateSyntaxError,
} from "../src/index";

describe("source positions", () => {
  it("reports line/column/offset for unknown fields", () => {
    const result = tryRender("line one\nline {{ a.b }} two", {});
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.error.position, { offset: 17, line: 2, column: 9 });
      assert.match(result.error.message, /at line 2, column 9/);
    }
  });

  it("points budget errors at the for tag", () => {
    const result = tryRender("hi\n{% for i in items %}x{% endfor %}", { items: [1] }, { maxSteps: 0 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof BudgetExceededError);
      assert.deepEqual(result.error.position, { offset: 3, line: 2, column: 1 });
    }
  });

  it("points budget errors at the filter name", () => {
    const result = tryRender('{{ "x" | upper }}', {}, { maxSteps: 0 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof BudgetExceededError);
      assert.deepEqual(result.error.position, { offset: 9, line: 1, column: 10 });
    }
  });

  it("points security errors at the offending expression", () => {
    const result = tryRender("ab {{ user.toString }}", { user: {} });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof SecurityError);
      assert.deepEqual(result.error.position, { offset: 6, line: 1, column: 7 });
    }
  });

  it("points cycle errors at the resolved path", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const result = tryRender("x {{ a.self.self }}", { a });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof CycleError);
      assert.deepEqual(result.error.position, { offset: 5, line: 1, column: 6 });
    }
  });

  it("reports positions for syntax errors", () => {
    assert.throws(
      () => render("abc {{ x", {}),
      (err: unknown) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.deepEqual((err as TemplateSyntaxError).position, { offset: 4, line: 1, column: 5 });
        return true;
      }
    );
    assert.throws(
      () => render("{% endfor %}", {}),
      (err: unknown) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.deepEqual((err as TemplateSyntaxError).position, { offset: 3, line: 1, column: 4 });
        return true;
      }
    );
  });
});
