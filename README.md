# csv-chunk-parser

按字节块接收的流式 CSV 解析库（TypeScript + Node.js 内置库，零运行时依赖）。

## 语义规则

- **任意切块**：`push(chunk)` 可切在任意字节位置（引号、`\r\n`、多字节 UTF-8 字符中间均可），解析结果与整块解析完全一致。
- **合法引号跨行**：`"` 为字段首字节时开启引号字段，引号内换行不切分记录；`""` 为转义引号。
- **非法引号隔离到物理行尾**：字段中间（或闭引号后垃圾区）出现的 `"` 按字面字节处理，不开启引号模式，换行仍正常结束记录——其影响被隔离在当前物理行内。
- **保留字段原始区间**：每个字段记录绝对字节偏移 `[start, end)`（含引号、不含分隔符/换行符）及原始字节 `raw`，偏移与切块方式无关。
- 换行符支持 `\n`、`\r\n`、`\r`；未闭合引号容错到 EOF；闭引号后的尾随垃圾保留在字段区间内。

## 用法

```ts
import { CsvParser, parseCsv } from "./src/csv.js";

// 流式：逐块送入
const parser = new CsvParser((record) => console.log(record));
parser.push(chunk1);
parser.push(chunk2);
parser.end();

// 便捷入口：整块或任意切块序列
const records = parseCsv(Buffer.from('a,"b\nc"', "utf8"));
// record: { fields: [{ value, raw, start, end, quoted }], start, end }
```

## 构建与测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

环境要求：Node.js（内置 `node:test` / `Buffer`）与 `tsc`（TypeScript 编译器）。
本仓库在 Node v22.22.1 + TypeScript 7.0.2 下验证；`types/node-shims.d.ts`
为离线环境提供最小 Node 内置模块类型声明，无需安装 `@types/node`。

## 测试构成

- **基本语义**（12 例）：字段区间、引号跨行、转义引号、非法引号隔离、CRLF/CR、
  空字段、尾随垃圾、未闭合引号、多字节字节偏移等。
- **全切块位置枚举对照**（5 组）：对 18 个固定样本枚举全部二切位置（74 例）、
  逐字节切块、短输入全部三切位置（176 例），以及 300 个确定性随机模糊输入的
  全二切位置（1865 例），均与整块解析结果做 `deepStrictEqual` 对照。

## 实际测试结果

`npm test` 实际输出（2026-10-05，Node v22.22.1）：

```
  二切位置对照用例数: 74
  三切位置对照用例数: 176
  模糊二切对照用例数: 1865
▶ 基本语义
  ✔ 简单两行与字段区间
  ✔ 合法引号字段内换行不切记录
  ✔ 转义引号
  ✔ 非法引号隔离到物理行尾，不换行拼接
  ✔ 非法引号后的内容不吞掉后续换行
  ✔ 对照：合法引号吞掉换行
  ✔ CRLF 与孤立 CR
  ✔ 空字段与行尾逗号
  ✔ 空输入与仅换行
  ✔ 闭引号后的尾随垃圾保留在字段区间内
  ✔ 未闭合引号容错到 EOF
  ✔ 多字节 UTF-8 下区间为字节偏移
▶ 全切块位置枚举对照
  ✔ 每个二切位置与整块解析一致
  ✔ 逐字节切块与整块解析一致
  ✔ 短输入枚举全部三切位置（四块）
  ✔ 随机模糊输入的全二切位置对照
  ✔ 流式 API 与便捷入口一致
ℹ tests 17
ℹ pass 17
ℹ fail 0
```

## 目录结构

- `src/csv.ts` — 解析器实现（字节级状态机）
- `test/csv.test.ts` — 单元测试 + 全切块位置枚举对照测试
- `types/node-shims.d.ts` — 最小 Node 内置模块类型声明（离线环境）
