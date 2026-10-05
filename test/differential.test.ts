import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { parse, type Engine, type ParseResult } from "../src/parse.js";
import { genData, genSchema, mulberry32 } from "./gen.js";

const SEEDS = 300;

function summarize(r: ParseResult): unknown {
  if (r.ok) {
    return { ok: true, offset: r.offset, value: toJsonable(r.value) };
  }
  return { ok: false, code: r.error.code, at: r.error.at, offset: r.offset };
}

function toJsonable(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.toString("hex");
  }
  if (Array.isArray(value)) {
    return value.map(toJsonable);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonable(v);
    }
    return out;
  }
  return value;
}

/** 同一份描述 + 数据，编译式解析器与直接解释器必须完全一致。 */
function checkAgree(schema: unknown, data: Buffer, ctx: string): ParseResult {
  const results = {} as Record<Engine, ParseResult>;
  for (const engine of ["compile", "interpret"] as const) {
    results[engine] = parse(schema, data, { engine });
  }
  const c = results.compile;
  const i = results.interpret;
  const dump = (): string =>
    `${ctx}\nschema=${JSON.stringify(schema)}\ndata=${data.toString("hex")}\n` +
    `compiled=${JSON.stringify(summarize(c))}\ninterpret=${JSON.stringify(summarize(i))}`;
  if (c.ok && i.ok) {
    assert.deepEqual(c.value, i.value, dump());
    assert.equal(c.offset, i.offset, dump());
    return c;
  }
  if (!c.ok && !i.ok) {
    assert.equal(c.error.code, i.error.code, dump());
    assert.equal(c.error.at, i.error.at, dump());
    assert.equal(c.offset, i.offset, dump());
    return c;
  }
  assert.fail(dump());
}

test("差分核对：编译式解析器 vs 直接格式解释器（随机描述）", (t) => {
  let cases = 0;
  let okCases = 0;
  let errCases = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = mulberry32(seed);
    const schema = genSchema(rng);
    const data = genData(schema, rng);

    // 完整数据：必须成功且双引擎一致
    const full = checkAgree(schema, data, `seed=${seed} case=full`);
    assert.ok(full.ok, `seed=${seed} generated data must parse: ${JSON.stringify(summarize(full))}`);
    assert.equal(full.offset, data.length, `seed=${seed} must consume all generated data`);
    cases++;
    okCases++;

    // 截断：双引擎必须以相同错误码失败
    for (let k = 0; k < 2 && data.length > 0; k++) {
      const cut = Math.floor(rng() * data.length);
      const r = checkAgree(schema, data.subarray(0, cut), `seed=${seed} case=trunc@${cut}`);
      assert.ok(!r.ok, `seed=${seed} truncated data must fail`);
      cases++;
      errCases++;
    }

    // 随机字节翻转：双引擎必须一致（同值或同错误码）
    for (let k = 0; k < 3 && data.length > 0; k++) {
      const mutated = Buffer.from(data);
      const pos = Math.floor(rng() * mutated.length);
      mutated[pos] = mutated[pos]! ^ (1 << Math.floor(rng() * 8));
      const r = checkAgree(schema, mutated, `seed=${seed} case=mutate@${pos}`);
      cases++;
      if (r.ok) {
        okCases++;
      } else {
        errCases++;
      }
    }
  }
  t.diagnostic(`differential cases: ${cases} (ok=${okCases}, err=${errCases}), seeds=1..${SEEDS}`);
  assert.ok(okCases > 0 && errCases > 0, "both success and error paths must be exercised");
});
