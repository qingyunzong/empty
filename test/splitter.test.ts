import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitStatements,
  splitStatementsChunked,
  StatementSplitter,
  UnclosedConstructError,
  type Statement,
} from "../src/splitter.js";

function texts(statements: Statement[]): string[] {
  return statements.map((s) => s.text);
}

test("splits on top-level semicolons and keeps original spans", () => {
  const script = "select 1; select 2;\nselect 3;";
  const statements = splitStatements(script);
  assert.deepEqual(texts(statements), ["select 1;", " select 2;", "\nselect 3;"]);
  assert.deepEqual(statements[0], { text: "select 1;", start: 0, end: 9 });
  assert.deepEqual(statements[1], { text: " select 2;", start: 9, end: 19 });
  assert.deepEqual(statements[2], { text: "\nselect 3;", start: 19, end: 29 });
  for (const s of statements) {
    assert.equal(script.slice(s.start, s.end), s.text);
  }
});

test("trailing statement without semicolon is kept", () => {
  const statements = splitStatements("select 1; select 2");
  assert.deepEqual(texts(statements), ["select 1;", " select 2"]);
  assert.equal(statements[1].end, 18);
});

test("empty statements are skipped", () => {
  assert.deepEqual(splitStatements(""), []);
  assert.deepEqual(splitStatements(" ; ;; \n "), []);
  assert.deepEqual(texts(splitStatements("a;;b;")), ["a;", "b;"]);
});

test("semicolons inside single/double quoted strings do not split", () => {
  const script = "select ';'; select \"a;b\";";
  assert.deepEqual(texts(splitStatements(script)), [
    "select ';';",
    " select \"a;b\";",
  ]);
});

test("doubled-quote and backslash escapes are honored", () => {
  const script = "select 'it''s; ok'; select 'a\\'; b'; select 3;";
  assert.deepEqual(texts(splitStatements(script)), [
    "select 'it''s; ok';",
    " select 'a\\'; b';",
    " select 3;",
  ]);
});

test("semicolons inside line comments do not split", () => {
  const script = "select 1; -- a ; b\nselect 2; // c ; d\nselect 3;";
  assert.deepEqual(texts(splitStatements(script)), [
    "select 1;",
    " -- a ; b\nselect 2;",
    " // c ; d\nselect 3;",
  ]);
});

test("semicolons inside block comments do not split", () => {
  const script = "select /* x;y;z */ 1; select/* multi\nline ; */2;";
  assert.deepEqual(texts(splitStatements(script)), [
    "select /* x;y;z */ 1;",
    " select/* multi\nline ; */2;",
  ]);
});

test("semicolons inside template literals do not split", () => {
  const script = "select `a;b`; select `c`; select 2;";
  assert.deepEqual(texts(splitStatements(script)), [
    "select `a;b`;",
    " select `c`;",
    " select 2;",
  ]);
});

test("template interpolation may contain semicolons and nested parens/braces/templates", () => {
  const script =
    "select `x${ f(1; 2, g(h(3), { k: `in;ner` })) }y`; select 2;";
  assert.deepEqual(texts(splitStatements(script)), [
    "select `x${ f(1; 2, g(h(3), { k: `in;ner` })) }y`;",
    " select 2;",
  ]);
});

test("template escape sequences are honored", () => {
  const script = "select `a\\`;b`; select 2;";
  assert.deepEqual(texts(splitStatements(script)), [
    "select `a\\`;b`;",
    " select 2;",
  ]);
});

test("unclosed string reports its opening position", () => {
  const script = "select 1;\nselect 'abc";
  assert.throws(
    () => splitStatements(script),
    (err: unknown) => {
      if (!(err instanceof UnclosedConstructError)) return false;
      assert.equal(err.kind, "string");
      assert.deepEqual(err.position, { index: 17, line: 2, column: 8 });
      return true;
    },
  );
});

test("unclosed block comment reports its opening position", () => {
  const script = "select 1; /* oops";
  assert.throws(
    () => splitStatements(script),
    (err: unknown) => {
      if (!(err instanceof UnclosedConstructError)) return false;
      assert.equal(err.kind, "blockComment");
      assert.deepEqual(err.position, { index: 10, line: 1, column: 11 });
      return true;
    },
  );
});

test("unclosed template reports its opening position", () => {
  const script = "a; `tpl";
  assert.throws(
    () => splitStatements(script),
    (err: unknown) => {
      if (!(err instanceof UnclosedConstructError)) return false;
      assert.equal(err.kind, "template");
      assert.deepEqual(err.position, { index: 3, line: 1, column: 4 });
      return true;
    },
  );
});

test("unclosed interpolation reports the position of its ${", () => {
  const script = "select `x${ f(1; 2)";
  assert.throws(
    () => splitStatements(script),
    (err: unknown) => {
      if (!(err instanceof UnclosedConstructError)) return false;
      assert.equal(err.kind, "interpolation");
      assert.deepEqual(err.position, { index: 9, line: 1, column: 10 });
      return true;
    },
  );
});

test("innermost unclosed construct is reported", () => {
  const script = "select `x${ 'abc";
  assert.throws(
    () => splitStatements(script),
    (err: unknown) => {
      if (!(err instanceof UnclosedConstructError)) return false;
      assert.equal(err.kind, "string");
      assert.equal(err.position.index, 12);
      return true;
    },
  );
});

const COMPREHENSIVE_SCRIPT = [
  "select 1; select ';';",
  "-- line comment ; with semis",
  "select 'it''s; tricky'; /* block ; comment */ select \"dq;\";",
  "// another ; comment",
  "select `tpl;${ fn(a; b, g(h(1), { c: `in;ner` })) }tail`;",
  "select 'esc\\'; still in string';",
  "  ;  ;",
  "select 7",
].join("\n");

test("chunked parsing matches whole-string parsing for every chunk size", () => {
  const expected = splitStatements(COMPREHENSIVE_SCRIPT);
  assert.ok(expected.length > 0);
  for (let size = 1; size <= COMPREHENSIVE_SCRIPT.length; size++) {
    const actual = splitStatementsChunked(COMPREHENSIVE_SCRIPT, [size]);
    assert.deepEqual(actual, expected, `chunk size ${size}`);
  }
});

test("chunked parsing matches whole-string parsing for random partitions", () => {
  const expected = splitStatements(COMPREHENSIVE_SCRIPT);
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 200; trial++) {
    const sizes: number[] = [];
    let remaining = COMPREHENSIVE_SCRIPT.length;
    while (remaining > 0) {
      const size = 1 + Math.floor(rand() * 17);
      sizes.push(size);
      remaining -= size;
    }
    const actual = splitStatementsChunked(COMPREHENSIVE_SCRIPT, sizes);
    assert.deepEqual(actual, expected, `trial ${trial} sizes=${sizes.join(",")}`);
  }
});

test("single-character chunking reproduces spans exactly", () => {
  const script = "a;'x;y';/*;*/`t${ f(1; {z: 2}) }u`;last";
  const whole = splitStatements(script);
  const splitter = new StatementSplitter();
  for (const ch of script) {
    splitter.write(ch);
  }
  assert.deepEqual(splitter.end(), whole);
  assert.deepEqual(texts(whole), ["a;", "'x;y';", "/*;*/`t${ f(1; {z: 2}) }u`;", "last"]);
});

test("chunked parsing reports the same unclosed position as whole parsing", () => {
  const script = "select 1;\nselect 'abc";
  let wholeError: UnclosedConstructError | undefined;
  try {
    splitStatements(script);
  } catch (err) {
    wholeError = err as UnclosedConstructError;
  }
  assert.ok(wholeError);
  const splitter = new StatementSplitter();
  let chunkedError: UnclosedConstructError | undefined;
  try {
    for (const ch of script) {
      splitter.write(ch);
    }
    splitter.end();
  } catch (err) {
    chunkedError = err as UnclosedConstructError;
  }
  assert.ok(chunkedError);
  assert.equal(chunkedError!.kind, wholeError!.kind);
  assert.deepEqual(chunkedError!.position, wholeError!.position);
});

test("write after end throws", () => {
  const splitter = new StatementSplitter();
  splitter.write("select 1;");
  splitter.end();
  assert.throws(() => splitter.write("x"), /after end/);
});
