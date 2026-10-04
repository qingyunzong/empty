# chunked-csv-parser

以**字节块**增量接收 CSV 的解析库：TypeScript 编写，仅依赖 Node.js 内置模块
（`node:buffer`、`node:test`、`node:assert`），无任何 npm 依赖。

## 语义规则

- **合法引号**：字段首字节为 `"` 时进入引号字段；`""` 为转义引号；引号内的
  `\n` / `\r\n` 是字段数据，**不切分记录**。
- **非法引号隔离到物理行尾**：字段中间出现的 `"`（或闭合引号后的垃圾字符）
  不开启引号区间，仅作为字面字节保留，字段标记 `malformed: true`；该物理行
  的换行仍正常结束记录，非法引号的影响被隔离在该物理行内。
- **行终止符**：`\n`、`\r\n`、单独的 `\r` 均结束记录。
- **原始区间保留**：每个字段记录其绝对字节区间 `[start, end)`（含引号的原始
  字节）与 `raw` 原文，记录（record）区间含行终止符；多字节 UTF-8 按字节
  偏移计算，切块落在字符中间也不受影响。

## API

```ts
import { CsvParser, parseCsv } from "./src/csv.ts";

const parser = new CsvParser();
parser.feed(chunk1);            // Buffer | Uint8Array | string，任意字节边界
parser.feed(chunk2);            // 每次返回本次完成的记录
const rest = parser.end();      // 冲刷末尾未终止的记录
parser.records;                 // 全部记录（RecordInfo[]）

parseCsv(buffer);               // 一次性整体解析
```

`FieldInfo`：`{ recordIndex, fieldIndex, start, end, raw, value, quoted, malformed }`
`RecordInfo`：`{ index, start, end, fields }`

## 构建与测试

```sh
npm test        # tsc 编译到 dist/ 后用 node --test 运行
npm run typecheck
```

测试（`test/csv.test.ts`）对 9 组用例**枚举全部切块位置**与整块解析对照：
134 个双块切点 + 276 个三块切点组合 + 逐字节喂入，共 410+ 种切块方式，
结果（含全部字段区间）必须与整块解析深度一致；并校验每个字段的
`[start, end)` 区间映射回输入字节与 `raw` 完全相等。

## 实际测试结果

环境：Node.js v22.22.1，tsc 7.0.2，Linux x86_64。`npm test` 输出：

```
> chunked-csv-parser@1.0.0 test
> tsc -p tsconfig.build.json && node --test dist/test/csv.test.js

TAP version 13
# Subtest: dist/test/csv.test.js
ok 1 - dist/test/csv.test.js
1..1
# tests 1
# pass 1
# fail 0
```

逐条用例（`node dist/test/csv.test.js`）：

```
ok 1 - simple records and fields with raw ranges
ok 2 - legal quotes: embedded newline does not split the record
ok 3 - legal quotes: escaped quotes and CRLF inside quotes
ok 4 - illegal quote is quarantined to the physical line end
ok 5 - junk after a closing quote is quarantined to the physical line end
ok 6 - CRLF, lone CR, and CR at end of input
ok 7 - empty fields, trailing comma, blank lines, empty input
ok 8 - multi-byte UTF-8 keeps byte-accurate ranges
ok 9 - unterminated quote at EOF flushes the open field
ok 10 - every 2-chunk split position matches whole-buffer parsing
ok 11 - every 3-chunk split pair matches whole-buffer parsing
ok 12 - byte-at-a-time feeding matches whole-buffer parsing
ok 13 - records accumulate identically regardless of emission timing
# tests 13
# pass 13
# fail 0
```

13/13 通过，0 失败。
