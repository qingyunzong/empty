# cmdspec

从结构化参数生成 POSIX 参数显示串的命令构造库，提供独立解码器，**从不启动 shell**。
纯 TypeScript + Node.js 内置库，零运行时依赖。

## 功能

- **显示串构造与独立解码**：`buildCommand(args)` 生成 POSIX 显示串，`parseCommand(str)`
  为独立解码器（单引号/双引号/反斜杠/行接续，不做任何 `$`、反引号展开）。
- **往返保证**：空串、单引号、换行等任意字节（除 NUL）均可 `parse(build(x)) === x`；
  NUL 一律拒绝。任何拼接不改变参数个数（短字符集穷举验收）。
- **响应文件展开**：`@file` 包含（相对包含文件解析、成环即报错）、`%if / %else / %endif`
  条件分支，参数可来自虚拟文件图中的多个文件。
- **逐字节来源**：`renderCommand` 输出的显示串每个字节都带来源标记
  （文件 + 偏移，渲染器添加的引号/转义/空格为 `null`）。
- **逆向编辑**：`applyEdits` 按参数下标把新值写回原来源文件；同一来源被多处引用
  （如菱形包含）时一次修改全局生效；对同一来源的冲突编辑整体拒绝，不产生任何部分写入。

## 响应文件格式

```
# 注释（仅行首）
%if NAME / %if !NAME / %if NAME=VALUE / %if NAME!=VALUE
%else
%endif
@other/file.rsp        # 包含另一响应文件（@ 未被引用时才生效）
plain "quoted arg" 'may
span lines' back\slash
```

## API 概览

```ts
import {
  buildCommand, parseCommand, quoteArg,        // src/quote.ts
  expandResponseFile,                          // src/response.ts
  renderCommand, applyEdits, EditConflictError // src/render.ts
} from './src/index.js';

// 1. 构造与解码
const display = buildCommand(['git', 'commit', '-m', "it's done\nnow"]);
parseCommand(display); // => ['git', 'commit', '-m', "it's done\nnow"]

// 2. 响应文件展开（虚拟文件图 + 条件分支）
const files = new Map([
  ['/main.rsp', 'alpha @sub.rsp\n%if MODE=fast\nfast-flag\n%endif\n'],
  ['/sub.rsp',  "'quoted arg'\n"],
]);
const expansion = expandResponseFile(files, '/main.rsp', { MODE: 'fast' });

// 3. 渲染显示串（保留每字节来源）
const rendered = renderCommand(expansion);
rendered.display;  // "alpha 'quoted arg' fast-flag"
rendered.byteMap;  // 每个字节 -> { file, offset } | null

// 4. 按参数逆向编辑原来源；冲突整体拒绝
const updated = applyEdits(rendered, [{ argIndex: 1, newValue: 'new value' }]);
updated.get('/sub.rsp'); // => "'new value'\n"
```

## 测试

```sh
npm test    # tsc 编译后运行 node --test
```

### 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出：`# tests 3 / # pass 3 / # fail 0`（3 个测试文件）。
逐文件明细（`node dist/test/<file>`）：

```
== dist/test/edit.test.js
ok 1 - per-byte provenance: every display byte maps to its source byte
ok 2 - reverse edit: one argument rewritten in its source file
ok 3 - reverse edit: values that look like directives/includes are quoted
ok 4 - shared source referenced twice: single edit updates all references
ok 5 - conflicting edits to a shared source are fully rejected
ok 6 - batch edits across multiple files apply together
# tests 6  # pass 6  # fail 0
== dist/test/quote.test.js
ok 1 - round-trip: empty string, single quotes, newlines
ok 2 - round-trip: multiple arguments keep count and values
ok 3 - NUL bytes are forbidden
ok 4 - decoder is independent: no expansion, malformed input rejected
ok 5 - exhaustive round-trip over short tricky character set (len <= 3)
ok 6 - exhaustive: concatenation never changes argument count (all pairs, len <= 2)
ok 7 - exhaustive: all triples over minimal tricky set keep count 3
# tests 7  # pass 7  # fail 0
== dist/test/response.test.js
ok 1 - expansion across multiple files with conditional branches
ok 2 - cross-file quoting: quotes inside included files, quoted @ stays literal
ok 3 - virtual file graph: diamond include duplicates args with identical spans
ok 4 - virtual file graph: include cycles are rejected
ok 5 - missing files and NUL bytes are rejected
ok 6 - end-to-end: expand -> render -> parse round-trips values and count
# tests 6  # pass 6  # fail 0
```

合计 19 个测试全部通过。穷举规模：16 字符棘手字符集全部长度 ≤3 串（4369 个）
逐一往返；73 个短串全配对（5329 对）验证拼接后参数个数恒为 2；21 个短串全三元组
（9261 组）验证参数个数恒为 3。

## 目录结构

- `src/quote.ts` — POSIX 引用与独立解码器
- `src/response.ts` — 响应文件展开（虚拟文件图、条件分支、来源跟踪）
- `src/render.ts` — 逐字节来源渲染与逆向编辑（冲突全拒绝）
- `types/node-shim.d.ts` — 离线环境最小 Node 内置模块类型声明
- `test/` — node:test 测试
