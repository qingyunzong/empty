import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, CsvParser, type CsvRecord } from "../src/csv.js";

interface FieldSnap {
  value: string;
  raw: string;
  start: number;
  end: number;
  quoted: boolean;
}
interface RecordSnap {
  start: number;
  end: number;
  fields: FieldSnap[];
}

function snapshot(records: CsvRecord[]): RecordSnap[] {
  return records.map((r) => ({
    start: r.start,
    end: r.end,
    fields: r.fields.map((f) => ({
      value: f.value,
      raw: f.raw.toString("utf8"),
      start: f.start,
      end: f.end,
      quoted: f.quoted,
    })),
  }));
}

function parseString(s: string): RecordSnap[] {
  return snapshot(parseCsv(Buffer.from(s, "utf8")));
}

/** 按给定切点把缓冲切成多块后解析 */
function parseWithSplits(buf: Buffer, splits: number[]): RecordSnap[] {
  const chunks: Buffer[] = [];
  let prev = 0;
  for (const s of splits) {
    chunks.push(buf.subarray(prev, s));
    prev = s;
  }
  chunks.push(buf.subarray(prev));
  return snapshot(parseCsv(chunks));
}

describe("基本语义", () => {
  test("简单两行与字段区间", () => {
    assert.deepStrictEqual(parseString("ab,cd\nef"), [
      {
        start: 0,
        end: 5,
        fields: [
          { value: "ab", raw: "ab", start: 0, end: 2, quoted: false },
          { value: "cd", raw: "cd", start: 3, end: 5, quoted: false },
        ],
      },
      {
        start: 6,
        end: 8,
        fields: [{ value: "ef", raw: "ef", start: 6, end: 8, quoted: false }],
      },
    ]);
  });

  test("合法引号字段内换行不切记录", () => {
    assert.deepStrictEqual(parseString('"a\nb",c\nd'), [
      {
        start: 0,
        end: 7,
        fields: [
          { value: "a\nb", raw: '"a\nb"', start: 0, end: 5, quoted: true },
          { value: "c", raw: "c", start: 6, end: 7, quoted: false },
        ],
      },
      {
        start: 8,
        end: 9,
        fields: [{ value: "d", raw: "d", start: 8, end: 9, quoted: false }],
      },
    ]);
  });

  test("转义引号", () => {
    const [rec] = parseString('"a""b"');
    assert.strictEqual(rec.fields[0].value, 'a"b');
    assert.strictEqual(rec.fields[0].raw, '"a""b"');
    assert.strictEqual(rec.fields[0].start, 0);
    assert.strictEqual(rec.fields[0].end, 6);
  });

  test("非法引号隔离到物理行尾，不换行拼接", () => {
    // 字段中间的 " 不开启引号模式，\n 照常切记录
    assert.deepStrictEqual(parseString('a"b,c\nd,e'), [
      {
        start: 0,
        end: 5,
        fields: [
          { value: 'a"b', raw: 'a"b', start: 0, end: 3, quoted: false },
          { value: "c", raw: "c", start: 4, end: 5, quoted: false },
        ],
      },
      {
        start: 6,
        end: 9,
        fields: [
          { value: "d", raw: "d", start: 6, end: 7, quoted: false },
          { value: "e", raw: "e", start: 8, end: 9, quoted: false },
        ],
      },
    ]);
  });

  test("非法引号后的内容不吞掉后续换行", () => {
    const snaps = parseString('x"y\nz"');
    assert.strictEqual(snaps.length, 2);
    assert.strictEqual(snaps[0].fields[0].value, 'x"y');
    assert.strictEqual(snaps[1].fields[0].value, 'z"');
  });

  test("对照：合法引号吞掉换行", () => {
    const snaps = parseString('"x\ny"');
    assert.strictEqual(snaps.length, 1);
    assert.strictEqual(snaps[0].fields[0].value, "x\ny");
  });

  test("CRLF 与孤立 CR", () => {
    const snaps = parseString("a,b\r\nc,d\re");
    assert.strictEqual(snaps.length, 3);
    assert.deepStrictEqual(
      snaps.map((r) => r.fields.map((f) => f.value)),
      [
        ["a", "b"],
        ["c", "d"],
        ["e"],
      ],
    );
    assert.strictEqual(snaps[0].end, 3); // \r 的偏移
    assert.strictEqual(snaps[1].start, 5);
  });

  test("空字段与行尾逗号", () => {
    const [rec] = parseString(",,");
    assert.deepStrictEqual(
      rec.fields.map((f) => [f.value, f.start, f.end]),
      [
        ["", 0, 0],
        ["", 1, 1],
        ["", 2, 2],
      ],
    );
    const [rec2] = parseString("a,");
    assert.deepStrictEqual(
      rec2.fields.map((f) => f.value),
      ["a", ""],
    );
  });

  test("空输入与仅换行", () => {
    assert.deepStrictEqual(parseString(""), []);
    const snaps = parseString("\n");
    assert.strictEqual(snaps.length, 1);
    assert.strictEqual(snaps[0].fields.length, 1);
    assert.strictEqual(snaps[0].fields[0].value, "");
    // 末尾换行不产生多余记录
    assert.strictEqual(parseString("a\n").length, 1);
  });

  test("闭引号后的尾随垃圾保留在字段区间内", () => {
    const [rec] = parseString('"ab"cd,e');
    assert.strictEqual(rec.fields[0].value, "abcd");
    assert.strictEqual(rec.fields[0].raw, '"ab"cd');
    assert.strictEqual(rec.fields[0].start, 0);
    assert.strictEqual(rec.fields[0].end, 6);
    assert.strictEqual(rec.fields[0].quoted, true);
  });

  test("未闭合引号容错到 EOF", () => {
    const [rec] = parseString('"ab');
    assert.strictEqual(rec.fields[0].value, "ab");
    assert.strictEqual(rec.fields[0].end, 3);
  });

  test("多字节 UTF-8 下区间为字节偏移", () => {
    // é 为 2 字节
    const [rec] = parseString('é,"x\ny"');
    assert.strictEqual(rec.fields[0].start, 0);
    assert.strictEqual(rec.fields[0].end, 2);
    assert.strictEqual(rec.fields[1].start, 3);
    assert.strictEqual(rec.fields[1].end, 8);
    assert.strictEqual(rec.fields[1].value, "x\ny");
  });
});

describe("全切块位置枚举对照", () => {
  const fixtures = [
    "",
    "a",
    "\n",
    "\r",
    "\r\n",
    ",",
    '"',
    '""',
    "a,b\nc,d",
    'a,"b\nc",d',
    '"a""b",c',
    'a"b,c\nd',
    '"ab"cd,"e"',
    "x\r\ny,z\n",
    'é,"x\ny"\r\n"w""',
    ",,\n,",
    '"unclosed',
    'p"q"\n"r',
  ];

  test("每个二切位置与整块解析一致", () => {
    let cases = 0;
    for (const s of fixtures) {
      const buf = Buffer.from(s, "utf8");
      const whole = parseWithSplits(buf, []);
      for (let i = 1; i < buf.length; i++) {
        assert.deepStrictEqual(
          parseWithSplits(buf, [i]),
          whole,
          `fixture=${JSON.stringify(s)} split=${i}`,
        );
        cases++;
      }
    }
    console.log(`  二切位置对照用例数: ${cases}`);
  });

  test("逐字节切块与整块解析一致", () => {
    for (const s of fixtures) {
      const buf = Buffer.from(s, "utf8");
      const whole = parseWithSplits(buf, []);
      const splits = Array.from({ length: Math.max(0, buf.length - 1) }, (_, i) => i + 1);
      assert.deepStrictEqual(
        parseWithSplits(buf, splits),
        whole,
        `fixture=${JSON.stringify(s)} byte-by-byte`,
      );
    }
  });

  test("短输入枚举全部三切位置（四块）", () => {
    let cases = 0;
    for (const s of fixtures) {
      const buf = Buffer.from(s, "utf8");
      const n = buf.length;
      if (n > 12) continue;
      const whole = parseWithSplits(buf, []);
      for (let i = 1; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          assert.deepStrictEqual(
            parseWithSplits(buf, [i, j]),
            whole,
            `fixture=${JSON.stringify(s)} splits=${i},${j}`,
          );
          cases++;
        }
      }
    }
    console.log(`  三切位置对照用例数: ${cases}`);
  });

  test("随机模糊输入的全二切位置对照", () => {
    // 确定性 PRNG（mulberry32）
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const alphabet = ["a", "b", '"', ",", "\n", "\r", "é"];
    let cases = 0;
    for (let round = 0; round < 300; round++) {
      const len = 1 + Math.floor(rand() * 12);
      let s = "";
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
      const buf = Buffer.from(s, "utf8");
      const whole = parseWithSplits(buf, []);
      for (let i = 1; i < buf.length; i++) {
        assert.deepStrictEqual(
          parseWithSplits(buf, [i]),
          whole,
          `fuzz=${JSON.stringify(s)} split=${i}`,
        );
        cases++;
      }
    }
    console.log(`  模糊二切对照用例数: ${cases}`);
  });

  test("流式 API 与便捷入口一致", () => {
    const s = 'a,"b\nc"\r\nd"e,f';
    const buf = Buffer.from(s, "utf8");
    const viaParseCsv = snapshot(parseCsv(buf));
    const records: CsvRecord[] = [];
    const parser = new CsvParser((r) => records.push(r));
    for (let i = 0; i < buf.length; i += 3) parser.push(buf.subarray(i, i + 3));
    parser.end();
    assert.deepStrictEqual(snapshot(records), viaParseCsv);
  });
});
