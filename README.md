# segment-analyzer

字符分析库（TypeScript + Node.js 内置库，无第三方依赖）：在**可追加、可尾部撤销、可快照恢复**的字节流上，增量维护"最长无重复码点片段"。

## 语义定义

- **码点而非字形**：一切按 Unicode 码点计数，组合字符（如 `e` + U+0301）算两个独立码点；UTF-16 代理对算一个码点。
- **片段合法**：片段 `[i, j)` 的两个边界都必须处于词法 NORMAL 状态——不跨未闭合的引号（`'` / `"` / `` ` ``），起点/终点也不落在字符串内转义序列（`\x`）的中间。
- **最佳片段**：合法且码点互不相同的片段中，码点长度最长者；并列时取起始更早者。
- **输出原字节区间**：`byteStart`/`byteEnd` 是原始字节流中的偏移（UTF-8 多字节字符按字节计）。

## API（`src/analyzer.ts`）

```ts
import { SegmentAnalyzer } from "./src/analyzer.ts";

const a = new SegmentAnalyzer();
a.append("ab");                 // 追加 string 或 Uint8Array
a.append(bytes);                // 多字节字符跨块拆分也能正确解码
a.best();                       // { cpStart, cpEnd, length, byteStart, byteEnd, text } | null
a.undo();                       // 撤销最近一次 append（按块）
const snap = a.save();          // JSON 安全快照（含撤销历史）
const b = SegmentAnalyzer.restore(JSON.parse(JSON.stringify(snap))); // 恢复后继续 append/undo
```

增量实现要点：滑动窗口（`lastSeen` 映射 + 日志化以便撤销回滚）、每个码点边界的词法状态、
`firstNormal` 指针（窗口内首个 NORMAL 边界）、逐步更新的最佳候选；撤销按块截断数组并回放
`lastSeen` 日志。跨块不完整的 UTF-8 尾部字节缓存在 `pending` 中，结果与切块方式无关。

## 核对 oracle（`src/brute.ts`）

`fullAnalysis(buffer)`：对整段缓冲重新词法分析，再枚举所有子串（O(n²)），
逐一检查码点唯一性与边界词法合法性，作为独立参考实现与增量分析器互相核对。

## 测试

```sh
npm test        # tsc 编译到 dist/ 后用 node --test 运行
npm run typecheck
```

覆盖：固定单测（并列取早、组合字符、字节区间、引号/转义边界、撤销、跨块解码）；
长度 ≤6 的 7 字符 tricky 字母表**全子串枚举穷举**（约 2 万个串，整段与随机两切分各核对一次）；
随机字节切块（400 组）、随机追加/撤销交错（150 组，每步核对）、
快照保存/恢复（含 JSON 往返，120 组）与全量词法 + 子串枚举 oracle 逐步比对。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - ascii: longest distinct run, tie broken by earliest start
ok 2 - combining marks count as separate code points, not graphemes
ok 3 - byte ranges are reported in original bytes for multibyte input
ok 4 - balanced quotes may be spanned; unclosed quotes may not
ok 5 - segment boundary cannot fall inside an escape sequence
ok 6 - no legal segment when a quote is never closed
ok 7 - single-quoted and backtick strings with escapes
ok 8 - undo restores earlier best candidate
ok 9 - multi-byte sequence split across chunks decodes identically
ok 10 - exhaustive: all strings up to length 6 over a tricky alphabet
ok 11 - random byte chunking matches full lex + substring enumeration
ok 12 - random interleaved append/undo matches oracle after every step
ok 13 - save/restore (incl. JSON round-trip) continues identically
ok 14 - snapshot undo reaches back across the save point
# tests 14
# pass 14
# fail 0
```

`tsc --noEmit` 类型检查通过，无错误。

## 文件结构

- `src/core.ts` — UTF-8 码点编解码（切块无关）与词法状态机
- `src/analyzer.ts` — 增量分析器：append / undo / save / restore / best
- `src/brute.ts` — 全量词法 + 子串枚举参考实现
- `test/analyzer.test.ts` — 单测 + 穷举 + 随机化 oracle 核对
- `types/node-shims.d.ts` — Node 内置模块的最小类型声明（离线环境，无需 @types/node）
