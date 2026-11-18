import test from "node:test";
import assert from "node:assert/strict";

import {
  DependencyCycleError,
  TemplateRenderError,
  createRenderEngine,
  renderTemplate,
} from "../build/index.js";

test("renders merged values, includes, and helper arguments", () => {
  const engine = createRenderEngine({
    defaults: {
      title: "Default",
      user: { name: "Ada", role: "reader" },
      ports: [80],
    },
    packageValues: {
      title: "Package",
      user: { role: "admin" },
      ports: [8080, 8443],
    },
    overrides: {
      user: { name: "Grace" },
    },
    templates: {
      page: "{{> header}}|{{upper user.name}}|{{user.role}}|{{ports}}",
      header: "[{{title}}]",
    },
    helpers: {
      upper: (_context, value) => String(value).toUpperCase(),
    },
  });

  assert.equal(
    engine.render("page"),
    "[Package]|GRACE|admin|[8080,8443]",
  );
  assert.equal(engine.version, 0);
  assert.deepStrictEqual(engine.mergedValues(), {
    title: "Package",
    user: { name: "Grace", role: "admin" },
    ports: [8080, 8443],
  });
});

test("renders UTF-8 bytes identical to the rendered text", () => {
  const engine = createRenderEngine({
    overrides: { name: "世界" },
    templates: { page: "你好，{{name}} 👋\n" },
  });
  const text = engine.render("page");
  const bytes = engine.renderBytes("page");

  assert.equal(text, "你好，世界 👋\n");
  assert.deepStrictEqual(Buffer.from(bytes), Buffer.from(text, "utf8"));
});

test("renders values supplied as nested native Maps", () => {
  const engine = createRenderEngine({
    defaults: new Map([
      ["name", "Ada"],
      ["user", new Map([["role", "reader"]])],
    ]),
    packageValues: new Map([["user", new Map([["role", "admin"]])]]),
    templates: { page: "{{name}}/{{user.role}}" },
  });

  assert.equal(engine.render("page"), "Ada/admin");
});

test("distinguishes missing and explicit null through helper context", () => {
  const engine = createRenderEngine({
    defaults: { present: null },
    templates: {
      page: '{{state "present"}}/{{state "missing"}}',
    },
    helpers: {
      state: (context, path) =>
        context.has(String(path)) ? String(context.lookup(String(path))) : "MISSING",
    },
  });

  assert.equal(engine.render("page"), "null/MISSING");
});

test("hot override replacement and helper redefinition do not alter prior results", () => {
  let engine;
  engine = createRenderEngine({
    overrides: { label: "old", count: 1 },
    templates: { page: "{{stamp label}}:{{count}}" },
    helpers: {
      stamp: (_context, value) => {
        engine.setOverrides({ label: "new", count: 2 });
        engine.setHelper("stamp", (_innerContext, innerValue) => `new:${innerValue}`);
        return `old:${value}`;
      },
    },
  });

  const first = engine.renderResult("page");
  const firstBytes = Buffer.from(first.bytes);

  assert.equal(first.text, "old:old:1");
  assert.equal(first.version, 0);
  assert.equal(engine.version, 2);

  assert.equal(first.text, "old:old:1");
  assert.deepStrictEqual(Buffer.from(first.bytes), firstBytes);

  const second = engine.renderResult("page");
  assert.equal(second.text, "new:new:2");
  assert.equal(second.version, 2);
  assert.deepStrictEqual(Buffer.from(first.bytes), firstBytes);
});

test("a batch keeps one snapshot when helpers replace values mid-batch", () => {
  let engine;
  engine = createRenderEngine({
    overrides: { label: "old" },
    templates: {
      first: "{{replace label}}",
      second: "{{echo label}}",
      third: "{{echo label}}",
    },
    helpers: {
      replace: (_context, value) => {
        engine.setOverrides({ label: "new" });
        engine.setHelper("echo", (_innerContext, innerValue) => `H2:${innerValue}`);
        return `H1:${value}`;
      },
      echo: (_context, value) => `H1:${value}`,
    },
  });

  const batch = engine.renderBatch(["first", "second", "third"]);
  assert.equal(batch.version, 0);
  assert.equal(batch.results.get("first").text, "H1:old");
  assert.equal(batch.results.get("second").text, "H1:old");
  assert.equal(batch.results.get("third").text, "H1:old");

  assert.equal(engine.render("second"), "H2:new");
});

test("a helper update does not affect a later include in the same render", () => {
  let changed = false;
  let engine;
  engine = createRenderEngine({
    overrides: { label: "old" },
    templates: {
      page: "{{replace}}|{{> tail}}",
      tail: "{{echo label}}",
    },
    helpers: {
      replace: () => {
        if (!changed) {
          changed = true;
          engine.setOverrides({ label: "new" });
          engine.setHelper("echo", (_context, value) => `H2:${value}`);
        }
        return "done";
      },
      echo: (_context, value) => `H1:${value}`,
    },
  });

  assert.equal(engine.render("page"), "done|H1:old");
  assert.equal(engine.render("page"), "done|H2:new");
});

test("batch bytes match individual one-shot renders from the same snapshot", () => {
  const engine = createRenderEngine({
    defaults: { name: "a" },
    overrides: { name: "b" },
    templates: {
      leaf: "{{name}}",
      page: "<{{> leaf}}>",
    },
  });
  const snapshot = engine.snapshot();
  const batch = snapshot.renderAll();

  for (const name of snapshot.templateNames()) {
    const individual = snapshot.renderBytes(name);
    const fromBatch = batch.results.get(name).bytes;
    assert.deepStrictEqual(Buffer.from(fromBatch), Buffer.from(individual));
    assert.deepStrictEqual(
      Buffer.from(individual),
      Buffer.from(snapshot.render(name), "utf8"),
    );
  }
});

test("a failed helper does not return partial text and keeps the location", () => {
  const engine = createRenderEngine({
    templates: { page: "prefix\n{{explode}}" },
    helpers: {
      explode: () => {
        throw new Error("boom");
      },
    },
  });

  assert.throws(
    () => engine.render("page"),
    (error) => {
      assert.ok(error instanceof TemplateRenderError);
      assert.equal(error.location.template, "page");
      assert.equal(error.location.line, 2);
      assert.match(error.message, /boom/);
      assert.match(error.message, /page:2:1/);
      return true;
    },
  );
});

test("dynamic helper calls detect recursion with a dependency path", () => {
  const engine = createRenderEngine({
    templates: { page: "{{outer}}" },
    helpers: {
      outer: (context) => context.invoke("outer"),
    },
  });

  assert.throws(
    () => engine.render("page"),
    (error) => {
      assert.ok(error instanceof DependencyCycleError);
      assert.deepStrictEqual(error.cycle, ["helper:outer", "helper:outer"]);
      return true;
    },
  );
});

test("convenience renderTemplate uses overrides and named helpers", () => {
  assert.equal(
    renderTemplate("{{shout name}}!", { name: "ada" }, {
      helpers: { shout: (_context, value) => String(value).toUpperCase() },
    }),
    "ADA!",
  );
});
