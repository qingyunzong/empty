# secret-scanner

有限字节模式 + 上下文白名单的秘密串扫描库。TypeScript 编写，仅依赖 Node.js 内置模块
（`node:test` / `node:assert` 用于测试），无第三方运行时依赖。

## 特性

- **有限字节模式**：模式为固定字节串（非正则），支持任意二进制输入。
- **块边界不漏**：`ChunkScanner` 每次推入保留 `maxPatternLen - 1` 字节尾部，
  跨块边界的命中不遗漏；通过上报下界去重，同一命中只报告一次。
- **白名单完整包含才遮盖**：命中区间 `[start, end)` 只有被某个白名单区间完整
  包含时才被遮盖；部分重叠（哪怕只差 1 字节）仍然上报。
- **原偏移报告**：所有命中报告相对整个输入的原始字节偏移（UTF-8 多字节字符
  按字节计）。
- **重叠归并 + 遮盖预览**：重叠/相接的命中区间归并后生成遮盖预览，预览与原文
  字节长度一致。

## 使用

```ts
import { scan, ChunkScanner, pattern } from "./src/scanner.js";

const patterns = [pattern("aws-key", "AKIAIOSFODNN7EXAMPLE"), pattern("token", "ghp_")];

// 整串扫描
const r = scan("key=AKIAIOSFODNN7EXAMPLE; tok=ghp_xx", patterns, {
  whitelist: [{ start: 4, end: 24 }], // 完整包含 aws-key -> 遮盖
});
// r.matches    -> [{ name: "token", start: 31, end: 35 }]
// r.suppressed -> [{ name: "aws-key", start: 4, end: 24 }]
// r.preview    -> "key=********************; tok=****xx"

// 任意切块流式扫描（与整串结果一致）
const s = new ChunkScanner(patterns);
s.push("key=AKIAIOSFOD");   // 秘密被块边界切开
s.push("NN7EXAMPLE; tok=");
s.push("ghp_xx");
const r2 = s.end();          // 与整串扫描结果完全相同
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc）。离线环境无 `@types/node`，
`types/node-shims.d.ts` 声明了用到的最小 Node API 表面。

### 实际运行结果（2026-10-05）

`npm test` 输出：

```
TAP version 13
# Subtest: out/test/scanner.test.js
ok 1 - out/test/scanner.test.js
1..1
# tests 1
# pass 1
# fail 0
```

测试文件内 7 个用例的详细结果（`node out/test/scanner.test.js`）：

```
ok 1 - 整串扫描报告原始字节偏移
ok 2 - 白名单仅遮盖完整包含的命中，部分重叠仍上报
ok 3 - 重叠命中归并为连续遮盖区间
ok 4 - 遮盖预览只替换命中区间且保持字节长度
ok 5 - 跨块边界的命中不遗漏
ok 6 - 任意切块与整串扫描结果一致（随机对照）
ok 7 - 边界情形：空输入、无模式、单字节块、整块一次推入
# tests 7
# pass 7
# fail 0
```

其中用例 6 以固定种子（mulberry32, seed=20261005）随机生成 300 组输入，
每组施加随机白名单与随机切块计划（含空块、单字节块），逐字段断言
`matches` / `suppressed` / `maskedRanges` / `preview` 与整串扫描完全一致。

## 文件结构

- `src/scanner.ts` — 库实现（`scan` / `ChunkScanner` / `findAll` / `mergeRanges` / `maskPreview`）
- `test/scanner.test.ts` — `node:test` 测试
- `types/node-shims.d.ts` — 离线环境下的最小 Node 类型声明
