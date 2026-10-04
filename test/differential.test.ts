import test from "node:test";
import assert from "node:assert/strict";
import { ParseError, Parser, compileFormat } from "../src/parser";
import { interpret } from "../src/interpreter";
import { generateCase, makeRng } from "../src/random";

test("compiling parser and direct interpreter agree on random formats", () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const { format, data, expected } = generateCase(seed);
    const plan = compileFormat(format);

    const parser = new Parser(data);
    const value = parser.run(plan);
    assert.deepStrictEqual(value, expected, `parser mismatch at seed ${seed}`);
    assert.equal(parser.offset, data.length, `parser left bytes at seed ${seed}`);

    const direct = interpret(format, data);
    assert.deepStrictEqual(direct.value, expected, `interpreter mismatch at seed ${seed}`);
    assert.equal(direct.bytesRead, data.length, `interpreter left bytes at seed ${seed}`);
  }
});

test("both implementations reject truncated input; parser cursor restores", () => {
  for (let seed = 1001; seed <= 1100; seed += 1) {
    const { format, data } = generateCase(seed);
    if (data.length === 0) continue;
    const rng = makeRng(seed * 7 + 1);
    const cut = rng.int(data.length);
    const short = data.subarray(0, cut);
    const plan = compileFormat(format);

    const parser = new Parser(short);
    assert.throws(() => parser.run(plan), ParseError, `parser accepted truncation at seed ${seed}`);
    assert.equal(parser.offset, 0, `cursor not restored at seed ${seed}`);

    assert.throws(
      () => interpret(format, short),
      undefined,
      `interpreter accepted truncation at seed ${seed}`,
    );
  }
});

test("trailing bytes are left unread by both implementations", () => {
  for (let seed = 2001; seed <= 2050; seed += 1) {
    const { format, data } = generateCase(seed);
    const extended = new Uint8Array(data.length + 3);
    extended.set(data);
    extended.set([0xde, 0xad, 0xbe], data.length);
    const plan = compileFormat(format);

    const parser = new Parser(extended);
    parser.run(plan);
    assert.equal(parser.offset, data.length, `parser offset at seed ${seed}`);

    const direct = interpret(format, extended);
    assert.equal(direct.bytesRead, data.length, `interpreter offset at seed ${seed}`);
  }
});
