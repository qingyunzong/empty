import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cliMain } from "../src/cli.js";
import { SchemaError, parse, type ParseFailure, type ParseResult } from "../src/parse.js";
import type { Schema } from "../src/schema.js";

const hex = (s: string): Buffer => Buffer.from(s.replaceAll(" ", ""), "hex");

const ENGINES = ["compile", "interpret"] as const;

function okValue(r: ParseResult): Record<string, unknown> {
  assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.value as Record<string, unknown>;
}

function expectFail(r: ParseResult): ParseFailure {
  if (r.ok) {
    assert.fail(`expected failure, got offset=${r.offset}`);
  }
  return r;
}

test("uint 大小端与偏移推进", () => {
  const schema: Schema = {
    root: "P",
    types: {
      P: {
        kind: "struct",
        fields: [
          { name: "a", type: { kind: "uint", bits: 16 } },
          { name: "b", type: { kind: "uint", bits: 16, littleEndian: true } },
          { name: "c", type: { kind: "uint", bits: 32 } },
        ],
      },
    },
  };
  for (const engine of ENGINES) {
    const r = parse(schema, hex("1234 3412 0000002a"), { engine });
    assert.deepEqual(okValue(r), { a: 0x1234, b: 0x1234, c: 42 });
    assert.equal(r.offset, 8);
  }
});

test("字段长度引用前字段", () => {
  const schema: Schema = {
    root: "P",
    types: {
      P: {
        kind: "struct",
        fields: [
          { name: "n", type: { kind: "uint", bits: 8 } },
          { name: "data", type: { kind: "bytes", length: { ref: "n" } } },
          { name: "tail", type: { kind: "uint", bits: 8 } },
        ],
      },
    },
  };
  for (const engine of ENGINES) {
    const r = parse(schema, hex("03 aabbcc 07"), { engine });
    const v = okValue(r);
    assert.equal(v.n, 3);
    assert.equal((v.data as Buffer).toString("hex"), "aabbcc");
    assert.equal(v.tail, 7);
    assert.equal(r.offset, 5);
  }
});

test("条件出现：when 命中才解析", () => {
  const schema: Schema = {
    root: "P",
    types: {
      P: {
        kind: "struct",
        fields: [
          { name: "flags", type: { kind: "uint", bits: 8 } },
          { name: "checksum", type: { kind: "uint", bits: 32 }, when: { field: "flags", equals: 1 } },
          { name: "tail", type: { kind: "uint", bits: 8 } },
        ],
      },
    },
  };
  for (const engine of ENGINES) {
    const present = okValue(parse(schema, hex("01 deadbeef 09"), { engine }));
    assert.equal(present.checksum, 0xdeadbeef);
    assert.equal(present.tail, 9);
    const absent = okValue(parse(schema, hex("00 09"), { engine }));
    assert.ok(!("checksum" in absent));
    assert.equal(absent.tail, 9);
  }
});

test("嵌套数组与命名类型引用", () => {
  const schema: Schema = {
    root: "P",
    types: {
      P: {
        kind: "struct",
        fields: [
          { name: "n", type: { kind: "uint", bits: 8 } },
          {
            name: "matrix",
            type: {
              kind: "array",
              count: 2,
              element: { kind: "array", count: { ref: "n" }, element: { kind: "uint", bits: 8 } },
            },
          },
          { name: "tags", type: { kind: "array", count: { ref: "n" }, element: { kind: "ref", name: "Tag" } } },
        ],
      },
      Tag: {
        kind: "struct",
        fields: [
          { name: "id", type: { kind: "uint", bits: 8 } },
          { name: "len", type: { kind: "uint", bits: 8 } },
          { name: "text", type: { kind: "bytes", length: { ref: "len" } } },
        ],
      },
    },
  };
  const data = hex("02 0102 0304 01 02 6869 02 01 7a");
  for (const engine of ENGINES) {
    const v = okValue(parse(schema, data, { engine }));
    assert.deepEqual(v.matrix, [
      [1, 2],
      [3, 4],
    ]);
    const tags = v.tags as Array<Record<string, unknown>>;
    assert.equal(tags.length, 2);
    assert.equal(tags[0]!.id, 1);
    assert.equal((tags[0]!.text as Buffer).toString("hex"), "6869");
    assert.equal((tags[1]!.text as Buffer).toString("hex"), "7a");
    assert.equal(parse(schema, data, { engine }).offset, data.length);
  }
});

test("定义图循环拒绝", () => {
  const selfCycle: Schema = {
    root: "A",
    types: {
      A: {
        kind: "struct",
        fields: [{ name: "next", type: { kind: "ref", name: "A" } }],
      },
    },
  };
  const indirect: Schema = {
    root: "A",
    types: {
      A: { kind: "struct", fields: [{ name: "b", type: { kind: "ref", name: "B" } }] },
      B: { kind: "struct", fields: [{ name: "a", type: { kind: "ref", name: "A" } }] },
    },
  };
  const viaArray: Schema = {
    root: "A",
    types: {
      A: {
        kind: "struct",
        fields: [
          { name: "n", type: { kind: "uint", bits: 8 } },
          { name: "items", type: { kind: "array", count: { ref: "n" }, element: { kind: "ref", name: "A" } } },
        ],
      },
    },
  };
  for (const [name, schema] of [["self", selfCycle], ["indirect", indirect], ["viaArray", viaArray]] as const) {
    for (const engine of ENGINES) {
      assert.throws(
        () => parse(schema, hex(""), { engine }),
        (e) => e instanceof SchemaError && /cycle/.test(e.message),
        `${name}/${engine} should reject cycle`
      );
    }
  }
});

test("非法定义：引用与形状错误", () => {
  const bad: Array<[string, Schema]> = [
    ["unknown type ref", { root: "A", types: { A: { kind: "struct", fields: [{ name: "x", type: { kind: "ref", name: "Nope" } }] } } }],
    ["length ref unknown field", { root: "A", types: { A: { kind: "struct", fields: [{ name: "d", type: { kind: "bytes", length: { ref: "n" } } }] } } }],
    ["length ref later field", {
      root: "A",
      types: {
        A: {
          kind: "struct",
          fields: [
            { name: "d", type: { kind: "bytes", length: { ref: "n" } } },
            { name: "n", type: { kind: "uint", bits: 8 } },
          ],
        },
      },
    }],
    ["length ref non-uint field", {
      root: "A",
      types: {
        A: {
          kind: "struct",
          fields: [
            { name: "n", type: { kind: "bytes", length: 1 } },
            { name: "d", type: { kind: "bytes", length: { ref: "n" } } },
          ],
        },
      },
    }],
    ["when unknown field", {
      root: "A",
      types: {
        A: {
          kind: "struct",
          fields: [{ name: "x", type: { kind: "uint", bits: 8 }, when: { field: "ghost", equals: 1 } }],
        },
      },
    }],
    ["duplicate field name", {
      root: "A",
      types: {
        A: {
          kind: "struct",
          fields: [
            { name: "x", type: { kind: "uint", bits: 8 } },
            { name: "x", type: { kind: "uint", bits: 8 } },
          ],
        },
      },
    }],
    ["bad uint bits", { root: "A", types: { A: { kind: "struct", fields: [{ name: "x", type: { kind: "uint", bits: 7 as 8 } }] } } }],
    ["root missing", { root: "Z", types: { A: { kind: "struct", fields: [{ name: "x", type: { kind: "uint", bits: 8 } }] } } }],
  ];
  for (const [name, schema] of bad) {
    for (const engine of ENGINES) {
      assert.throws(() => parse(schema, hex(""), { engine }), SchemaError, `${name}/${engine}`);
    }
  }
});

test("长度乘法防溢出", () => {
  const arraySchema: Schema = {
    root: "P",
    types: {
      P: {
        kind: "struct",
        fields: [
          { name: "n", type: { kind: "uint", bits: 32 } },
          { name: "items", type: { kind: "array", count: { ref: "n" }, element: { kind: "uint", bits: 32 } } },
        ],
      },
    },
  };
  const bytesSchema: Schema = {
    root: "P",
    types: {
      P: {
        kind: "struct",
        fields: [
          { name: "n", type: { kind: "uint", bits: 32 } },
          { name: "data", type: { kind: "bytes", length: { ref: "n" } } },
        ],
      },
    },
  };
  const zeroElemSchema: Schema = {
    root: "P",
    types: {
      P: {
        kind: "struct",
        fields: [
          { name: "n", type: { kind: "uint", bits: 32 } },
          { name: "items", type: { kind: "array", count: { ref: "n" }, element: { kind: "bytes", length: 0 } } },
        ],
      },
    },
  };
  for (const engine of ENGINES) {
    // 0xFFFFFFFF * 4 字节：乘积超上限 -> overflow，游标恢复到结构起点
    const r1 = expectFail(parse(arraySchema, hex("ffffffff"), { engine }));
    assert.equal(r1.error.code, "overflow");
    assert.equal(r1.offset, 0);
    // bytes 长度超上限 -> overflow
    const r2 = expectFail(parse(bytesSchema, hex("ffffffff"), { engine }));
    assert.equal(r2.error.code, "overflow");
    // 零尺寸元素 + 巨大计数 -> overflow（防空转）
    const r3 = expectFail(parse(zeroElemSchema, hex("001e8480"), { engine }));
    assert.equal(r3.error.code, "overflow");
    // 计数合法但数据不足 -> eof
    const r4 = expectFail(parse(arraySchema, hex("00000064 00000000"), { engine }));
    assert.equal(r4.error.code, "eof");
  }
  // 固定计数超上限：schema 级拒绝
  const badFixed: Schema = {
    root: "P",
    types: {
      P: {
        kind: "struct",
        fields: [{ name: "a", type: { kind: "array", count: 0x80000000, element: { kind: "uint", bits: 8 } } }],
      },
    },
  };
  assert.throws(() => parse(badFixed, hex("")), SchemaError);
});

test("出错游标恢复到结构起点", () => {
  const schema: Schema = {
    root: "P",
    types: {
      P: {
        kind: "struct",
        fields: [
          { name: "a", type: { kind: "uint", bits: 8 } },
          {
            name: "b",
            type: {
              kind: "struct",
              fields: [
                { name: "c", type: { kind: "uint", bits: 8 } },
                { name: "d", type: { kind: "uint", bits: 16 } },
              ],
            },
          },
        ],
      },
    },
  };
  for (const engine of ENGINES) {
    // a=01, b.c=02, b.d 需要 2 字节但缓冲区结束 -> 在偏移 2 处失败，游标恢复到根结构起点 0
    const r = expectFail(parse(schema, hex("0102"), { engine }));
    assert.equal(r.error.code, "eof");
    assert.equal(r.error.at, 2);
    assert.equal(r.offset, 0);
    // 从非零偏移开始解析失败：游标恢复到该结构起点（起始偏移）
    const r2 = expectFail(parse(schema, hex("ffffff0102"), { engine, offset: 3 }));
    assert.equal(r2.error.at, 5);
    assert.equal(r2.offset, 3);
    // 成功时偏移正常推进
    const r3 = parse(schema, hex("ffffff01020003"), { engine, offset: 3 });
    assert.ok(r3.ok);
    assert.equal(r3.offset, 7);
  }
});

test("CLI：读取示例并核对双引擎一致", () => {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const schemaPath = join(repoRoot, "examples", "packet.schema.json");
  const binPath = join(repoRoot, "examples", "packet.bin");

  const runCli = (args: string[]): { code: number; out: string; err: string } => {
    let out = "";
    let err = "";
    const code = cliMain(args, {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
    });
    return { code, out, err };
  };

  const ok = runCli([schemaPath, binPath]);
  assert.equal(ok.code, 0, ok.err);
  const parsed = JSON.parse(ok.out) as { ok: boolean; offset: number; value: Record<string, unknown> };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.offset, 23);
  assert.equal(parsed.value.magic, 0xabcd);
  assert.equal(parsed.value.payload, "414243");
  assert.equal(parsed.value.checksum, 0x01020304);
  assert.deepEqual(parsed.value.tags, [
    { id: 1, textLen: 2, text: "6869" },
    { id: 2, textLen: 3, text: "686579" },
  ]);

  // --engine interpret 输出必须与编译引擎逐字节一致
  const okInterpret = runCli([schemaPath, binPath, "--engine", "interpret"]);
  assert.equal(okInterpret.code, 0, okInterpret.err);
  assert.equal(okInterpret.out, ok.out);

  // 截断数据 -> 退出码 1，ok:false，游标恢复到结构起点
  const full = Buffer.from("abcd010103004142430102030402010268690203686579", "hex");
  const truncPath = join(tmpdir(), "descparse-packet-trunc.bin");
  writeFileSync(truncPath, full.subarray(0, 6));
  const trunc = runCli([schemaPath, truncPath]);
  assert.equal(trunc.code, 1);
  const truncOut = JSON.parse(trunc.out) as { ok: boolean; offset: number; error: { code: string } };
  assert.equal(truncOut.ok, false);
  assert.equal(truncOut.error.code, "eof");
  assert.equal(truncOut.offset, 0);

  // schema 错误（定义图循环）-> 退出码 2
  const badSchemaPath = join(tmpdir(), "descparse-bad-schema.json");
  writeFileSync(
    badSchemaPath,
    JSON.stringify({
      root: "A",
      types: { A: { kind: "struct", fields: [{ name: "x", type: { kind: "ref", name: "A" } }] } },
    })
  );
  const bad = runCli([badSchemaPath, binPath]);
  assert.equal(bad.code, 2);
  assert.ok(/cycle/.test(bad.err));

  // 用法错误 -> 退出码 2
  assert.equal(runCli([]).code, 2);
  assert.equal(runCli([schemaPath, binPath, "--engine", "bogus"]).code, 2);
});
