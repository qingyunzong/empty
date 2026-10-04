import { describe, test } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { applyEdits, planRename, type Edit, type RenameFailure } from "../src/index.js";

function renameAndApply(source: string, position: number, newName: string): string {
  const result = planRename(source, position, newName);
  if (!result.ok) throw new Error(`rename failed: ${result.code}: ${result.message}`);
  return applyEdits(source, result.edits);
}

function expectFailure(source: string, position: number, newName: string): RenameFailure {
  const result = planRename(source, position, newName);
  if (result.ok) throw new Error("expected rename to be rejected, but it succeeded");
  return result;
}

describe("basic rename", () => {
  test("renames the declaration and every reference that resolves to it", () => {
    const src = "let total = 1;\ntotal = total + 2;\n";
    const result = planRename(src, src.indexOf("total"), "sum");
    ok(result.ok);
    equal(result.oldName, "total");
    equal(result.occurrences, 3);
    equal(applyEdits(src, result.edits), "let sum = 1;\nsum = sum + 2;\n");
  });

  test("edit plan is a sorted, non-overlapping list of byte spans over the old name", () => {
    const src = "let alpha = 1;\n{\n  alpha = alpha + alpha;\n}\nalpha;\n";
    const result = planRename(src, src.indexOf("alpha"), "beta");
    ok(result.ok);
    equal(result.occurrences, 5);
    let prevEnd = -1;
    for (const edit of result.edits) {
      ok(edit.start >= prevEnd, "edits are sorted and non-overlapping");
      equal(src.slice(edit.start, edit.end), "alpha");
      equal(edit.newText, "beta");
      prevEnd = edit.end;
    }
  });

  test("cursor may sit on any reference, not just the declaration", () => {
    const src = "let value = 1;\nvalue = value + 1;\n";
    const onSecondRef = src.lastIndexOf("value");
    equal(renameAndApply(src, onSecondRef, "v"), "let v = 1;\nv = v + 1;\n");
  });

  test("cursor at the end offset of an identifier still counts", () => {
    const src = "let abc = 1;\nabc;\n";
    const declStart = src.indexOf("abc");
    equal(renameAndApply(src, declStart + 3, "xyz"), "let xyz = 1;\nxyz;\n");
  });
});

describe("nested shadowing", () => {
  const src = "let x = 1;\n{\n  let x = 2;\n  x = x + 1;\n}\nx = x + 1;\n";

  test("renaming the outer declaration leaves the shadowing inner one untouched", () => {
    const outerDecl = src.indexOf("x");
    equal(
      renameAndApply(src, outerDecl, "y"),
      "let y = 1;\n{\n  let x = 2;\n  x = x + 1;\n}\ny = y + 1;\n",
    );
  });

  test("renaming the inner shadowed declaration leaves the outer one untouched", () => {
    const innerDecl = src.indexOf("x = 2");
    equal(
      renameAndApply(src, innerDecl, "z"),
      "let x = 1;\n{\n  let z = 2;\n  z = z + 1;\n}\nx = x + 1;\n",
    );
  });

  test("references inside the shadowed block resolve to the inner declaration", () => {
    const innerRef = src.indexOf("x = x + 1");
    const result = planRename(src, innerRef, "z");
    ok(result.ok);
    equal(result.occurrences, 3); // inner decl + two inner refs only
  });
});

describe("block-wide visibility (use before define)", () => {
  test("a reference textually before the declaration resolves to it", () => {
    const src = "{\n  count = count + 1;\n  let count = 0;\n}\n";
    const result = planRename(src, src.indexOf("count"), "n");
    ok(result.ok);
    equal(result.occurrences, 3);
    equal(applyEdits(src, result.edits), "{\n  n = n + 1;\n  let n = 0;\n}\n");
  });

  test("a reference in a nested block before the outer declaration still resolves", () => {
    const src = "{\n  total;\n}\nlet total = 1;\n";
    equal(renameAndApply(src, src.indexOf("total"), "sum"), "{\n  sum;\n}\nlet sum = 1;\n");
  });
});

describe("capture rejection (all-or-nothing)", () => {
  test("rejects when an intervening declaration would steal a reference of the target", () => {
    const src = "let a = 1;\n{\n  let b = 2;\n  a = a + b;\n}\n";
    const result = expectFailure(src, src.indexOf("a"), "b");
    equal(result.code, "capture");
    match(result.message, /capture/);
    ok(!("edits" in result), "a rejected rename produces no edits at all");
  });

  test("rejects when an existing reference to the new name would be captured", () => {
    const src = "let b = 10;\n{\n  let a = 1;\n  b = a + 1;\n}\n";
    const result = expectFailure(src, src.indexOf("a"), "b");
    equal(result.code, "capture");
  });

  test("rejects when a currently unresolved reference would become captured", () => {
    const src = "{\n  let a = 1;\n  b = a + 1;\n}\n";
    const result = expectFailure(src, src.indexOf("a"), "b");
    equal(result.code, "capture");
    match(result.message, /unresolved/);
  });

  test("rejects when the same block already declares the new name", () => {
    const src = "let a = 1;\nlet b = 2;\na = a + b;\n";
    const result = expectFailure(src, src.indexOf("a"), "b");
    equal(result.code, "conflict");
  });

  test("a shadowing declaration with no conflicting references does not block the rename", () => {
    const src = "let a = 1;\n{\n  let b = 2;\n  b = b + 1;\n}\na;\n";
    equal(
      renameAndApply(src, src.indexOf("a"), "b"),
      "let b = 1;\n{\n  let b = 2;\n  b = b + 1;\n}\nb;\n",
    );
  });
});

describe("functions and parameters", () => {
  test("renames a function including recursive and outer call sites", () => {
    const src = "function fib(n) {\n  let r = n;\n  return fib(r);\n}\nfib(3);\n";
    const result = planRename(src, src.indexOf("fib"), "f");
    ok(result.ok);
    equal(result.occurrences, 3);
    equal(
      applyEdits(src, result.edits),
      "function f(n) {\n  let r = n;\n  return f(r);\n}\nf(3);\n",
    );
  });

  test("parameters are declarations; renaming one touches only its references", () => {
    const src = "function g(v) {\n  return v + 1;\n}\n";
    equal(
      renameAndApply(src, src.indexOf("v"), "value"),
      "function g(value) {\n  return value + 1;\n}\n",
    );
  });

  test("a parameter shadows the outer declaration of the same name", () => {
    const src = "let v = 1;\nfunction g(v) {\n  return v;\n}\nv = v + 1;\n";
    equal(
      renameAndApply(src, src.indexOf("v"), "w"),
      "let w = 1;\nfunction g(v) {\n  return v;\n}\nw = w + 1;\n",
    );
  });
});

describe("invalid input", () => {
  const src = "let a = 1;\na;\n";

  test("keyword as new name is rejected", () => {
    equal(expectFailure(src, src.indexOf("a"), "function").code, "invalid-new-name");
  });

  test("malformed new name is rejected", () => {
    equal(expectFailure(src, src.indexOf("a"), "2x").code, "invalid-new-name");
    equal(expectFailure(src, src.indexOf("a"), "has space").code, "invalid-new-name");
  });

  test("position on a non-identifier is rejected", () => {
    equal(expectFailure(src, src.indexOf("1"), "b").code, "no-identifier-at-position");
  });

  test("unresolved identifier at the cursor is rejected", () => {
    const s = "foo = 1;\n";
    equal(expectFailure(s, s.indexOf("foo"), "bar").code, "unresolved-identifier");
  });

  test("syntactically invalid source is rejected", () => {
    equal(expectFailure("let = ;", 0, "b").code, "parse-error");
  });
});

describe("applyEdits", () => {
  test("applies edits regardless of input order", () => {
    const edits: Edit[] = [
      { start: 8, end: 9, newText: "y" },
      { start: 4, end: 5, newText: "x" },
    ];
    equal(applyEdits("let a = b;", edits), "let x = y;");
  });

  test("throws on overlapping edits", () => {
    let threw = false;
    try {
      applyEdits("abc", [
        { start: 0, end: 2, newText: "x" },
        { start: 1, end: 3, newText: "y" },
      ]);
    } catch {
      threw = true;
    }
    ok(threw);
  });

  test("edit plan deep-equals the expected byte spans", () => {
    const src = "let q = 1;\nq;\n";
    const result = planRename(src, src.indexOf("q"), "qq");
    ok(result.ok);
    deepEqual(result.edits, [
      { start: 4, end: 5, newText: "qq" },
      { start: 11, end: 12, newText: "qq" },
    ]);
  });
});
