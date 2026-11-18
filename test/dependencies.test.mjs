import test from "node:test";
import assert from "node:assert/strict";

import {
  DependencyCycleError,
  RenderEngine,
  TemplateSyntaxError,
  UnknownDependencyError,
  parseTemplate,
} from "../build/index.js";

test("parses include and helper dependency locations", () => {
  const parsed = parseTemplate(
    "first line\n{{> header}}\n  {{upper user.name}}",
    { name: "page", helpers: new Set(["upper"]) },
  );

  assert.deepStrictEqual(
    parsed.dependencies.map((dependency) => ({
      target: dependency.target,
      reason: dependency.reason,
      line: dependency.location?.line,
      column: dependency.location?.column,
    })),
    [
      { target: "template:header", reason: "include", line: 2, column: 1 },
      { target: "helper:upper", reason: "helper", line: 3, column: 3 },
    ],
  );
});

test("orders templates and helpers dependency-first", () => {
  const engine = new RenderEngine({
    templates: {
      page: "{{> header}} {{shout title}}",
      header: "{{> badge}}",
      badge: "[{{title}}]",
    },
    helpers: {
      shout: (_context, value) => String(value).toUpperCase(),
    },
  });

  const order = engine.dependencyOrder();
  assert.deepStrictEqual(
    [...order].sort(),
    [
      "helper:shout",
      "template:badge",
      "template:header",
      "template:page",
    ],
  );
  assert.ok(order.indexOf("template:badge") < order.indexOf("template:header"));
  assert.ok(order.indexOf("template:header") < order.indexOf("template:page"));
  assert.ok(order.indexOf("helper:shout") < order.indexOf("template:page"));
});

test("reports the exact include that closes a template cycle", () => {
  const engine = new RenderEngine({
    templates: {
      a: "A\n  {{> b}}",
      b: "B\n{{> a}}",
    },
  });

  assert.throws(
    () => engine.render("a"),
    (error) => {
      assert.ok(error instanceof DependencyCycleError);
      assert.deepStrictEqual(error.cycle, [
        "template:a",
        "template:b",
        "template:a",
      ]);
      assert.equal(error.locations.length, 2);
      assert.deepStrictEqual(
        error.locations.map(({ template, line, column }) => ({
          template,
          line,
          column,
        })),
        [
          { template: "a", line: 2, column: 3 },
          { template: "b", line: 2, column: 1 },
        ],
      );
      assert.match(error.message, /a:2:3/);
      assert.match(error.message, /b:2:1/);
      return true;
    },
  );
});

test("detects cycles between templates and declared helper dependencies", () => {
  const engine = new RenderEngine({
    templates: {
      page: "{{decorate title}}",
    },
    helpers: {
      decorate: {
        dependencies: ["template:page"],
        render: (_context, value) => `**${value}**`,
      },
    },
  });

  assert.throws(
    () => engine.dependencyOrder(),
    (error) => {
      assert.ok(error instanceof DependencyCycleError);
      assert.deepStrictEqual(error.cycle, [
        "template:page",
        "helper:decorate",
        "template:page",
      ]);
      assert.equal(error.locations[0].template, "page");
      assert.match(error.message, /page:1:1/);
      return true;
    },
  );
});

test("detects helper-to-helper cycles", () => {
  const engine = new RenderEngine({
    helpers: {
      one: { dependencies: ["helper:two"], render: () => "1" },
      two: { dependencies: ["one"], render: () => "2" },
    },
  });

  assert.throws(
    () => engine.dependencyOrder(),
    (error) => {
      assert.ok(error instanceof DependencyCycleError);
      assert.deepStrictEqual(error.cycle, [
        "helper:one",
        "helper:two",
        "helper:one",
      ]);
      return true;
    },
  );
});

test("reports a missing include at its source location", () => {
  const engine = new RenderEngine({
    templates: { page: "before\n{{> absent}}" },
  });

  assert.throws(
    () => engine.render("page"),
    (error) => {
      assert.ok(error instanceof UnknownDependencyError);
      assert.equal(error.dependency, "template:absent");
      assert.equal(error.location.template, "page");
      assert.equal(error.location.line, 2);
      assert.equal(error.location.column, 1);
      return true;
    },
  );
});

test("reports syntax errors with line and column", () => {
  assert.throws(
    () => parseTemplate("ok\n{{> broken", { name: "bad" }),
    (error) => {
      assert.ok(error instanceof TemplateSyntaxError);
      assert.equal(error.line, 2);
      assert.equal(error.column, 1);
      assert.match(error.message, /bad:2:1/);
      return true;
    },
  );
});

