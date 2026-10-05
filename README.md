# sandbox-vfs

文件访问模拟库：在内存虚拟文件树上做沙箱化路径解析与安全打开。

- **逐步解析**：相对路径（`.` / `..`）与符号链接逐分量展开，每展开一步都核对沙箱边界（`SandboxEscapeError`）。
- **链接保护**：单次解析内检测符号链接循环（`SymlinkLoopError`），展开次数超限报错（`TooManyExpansionsError`，默认上限 40）。
- **代际绑定**：`stat` / `exists` 捕获路径上每个目录的代际快照签发 `AccessTicket`；`open` 重新解析时逐目录比对代际，任何中间目录被修改（如符号链接被换目标）都会在跟随新链接**之前**抛出 `StaleGenerationError`，外部对象不会被打开。

## 结构

- `src/vfs.ts` — 虚拟文件树（目录 / 文件 / 符号链接；目录带 `generation` 计数，结构变更即递增）
- `src/resolver.ts` — `SandboxResolver`：逐分量解析、边界核对、循环与超限检测
- `src/sandbox.ts` — `SandboxFS`：`stat` / `exists` / `open`，代际绑定的 check-then-open
- `src/errors.ts` — 错误类型（`ENOENT` / `EESCAPE` / `ELOOP` / `EMAXEXPAND` / `ESTALEGEN` …）
- `test/` — `node:test` 测试

## 运行

```sh
npm test   # tsc 编译后运行 node --test
```

零依赖（仅 Node.js 内置模块与 TypeScript 编译器）。

## 测试结果（实际运行记录）

环境：Node.js v22.22.1，npm 9.2.0，tsc 7.0.2，2026-10-05 于本仓库工作区执行 `npm test`。

```
TAP version 13
ok 1 - dist/test/resolver.test.js
ok 2 - dist/test/toctou.test.js
# tests 2
# suites 0
# pass 2
# fail 0
# duration_ms 470.399686
```

逐条用例（19 条全部通过）：

```
SandboxResolver: relative paths
  ok 1 - resolves plain and dotted relative paths
  ok 2 - resolves ".." that stays inside the sandbox
  ok 3 - rejects ".." that escapes the sandbox root
  ok 4 - reports missing files and non-directory traversal
SandboxResolver: symlink expansion
  ok 1 - follows a relative symlink against its containing directory
  ok 2 - follows symlink chains and keeps resolving the remainder
  ok 3 - rejects absolute symlink targets outside the sandbox
  ok 4 - rejects relative symlink targets that climb out of the sandbox
  ok 5 - detects two-link loops
  ok 6 - detects self-referential loops
  ok 7 - enforces the expansion limit on non-looping chains
SandboxFS: generation-bound check-then-open
  ok 1 - opens when the generation captured by exists() is unchanged
  ok 2 - refuses to open after the symlink is swapped to an outside target
  ok 3 - refuses to open after the symlink is swapped to another inside file
  ok 4 - detects swaps through intermediate directories
  ok 5 - is not disturbed by mutations in unrelated directories
  ok 6 - rejects a ticket minted for a different path
  ok 7 - without a ticket the boundary check still blocks escapes (defense in depth)
  ok 8 - exists() reports false for missing paths without throwing
```

关键证明（`test/toctou.test.ts` 用例 2）：`exists('current')` 后攻击者把 `/sandbox/current`
换指向 `/external/secret.txt`，`open('current', ticket)` 抛出 `StaleGenerationError`，
且外部文件对象 `openCount === 0` —— 外部对象从未被打开。
