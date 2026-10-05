# sandboxed-file-access

纯 TypeScript / Node.js 内置库实现的**文件访问模拟库**：在虚拟文件树上解析相对路径与符号链接，
每展开一步核对沙箱边界，检测链接循环与展开次数超限；存在性检查（`exists`）与打开（`open`）
绑定同一组目录代际（generation），可证明换链攻击下外部对象永远不会被打开。

## 结构

- `src/vfs.ts` — 内存虚拟文件树（目录 / 常规文件 / 符号链接）。目录每次结构性变更
  （新增 / 替换 / 删除子项）都会自增 `generation`；`Vfs.replace()` 用于模拟攻击者换链。
- `src/sandbox.ts` — chroot 式沙箱视图，核心解析器。
- `src/errors.ts` — `FsError`，错误码：`ENOENT` `ENOTDIR` `EISDIR` `ELOOP` `EMLINK`
  `ESCAPE` `ESTALE` `EINVAL`。
- `test/sandbox.test.ts` — 基于 `node:test` + `node:assert/strict` 的 16 项测试。

## 解析语义（`Sandbox.resolve`）

- 逐分量行走：`"."` 跳过，`".."` 在沙箱根处钳制（chroot 语义，永不向上逃逸）。
- 每展开一次符号链接，先把链接目标（绝对 = 虚拟树绝对，相对 = 相对所在目录）归一化，
  **在继续行走之前**核对结果是否仍以沙箱根为前缀；越界即抛 `ESCAPE`——因此链式链接
  在中间任一步越界都会被当场截获。
- 循环检测：按链接节点身份记录已访问集合，重复即 `ELOOP`；展开次数超过
  `maxExpansions`（默认 40，仿 Linux `MAXSYMLINKS`）抛 `EMLINK`，二者相互独立。

## 检查-打开同代际（`exists` → `open`）

- `exists(path)` 返回 `LookupTicket`，记录解析路径上**每个目录**的
  `{ path, generation }`。
- `open(path, ticket)` 在任何符号链接被跟随**之前**，按票中记录的字面路径逐一核对
  目录代际；任一目录在检查与打开之间被修改（如换链、删后重建）即抛 `ESTALE`，
  新链接根本不会被遍历。
- 不带票的 `open` 仍受逐步边界检查保护：换向沙箱外的链接抛 `ESCAPE`。
- 每个 `FileNode` 带 `openCount` 计数，测试据此断言外部对象 `/etc/secret`
  在所有攻击场景下 `openCount === 0`，即从未被打开。

## 运行

```sh
npm test   # = tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc；本环境无法访问 npm registry，
`types/node-shim.d.ts` 为 `node:test` / `node:assert/strict` 的最小离线声明）。

## 实测结果（2026-10-05，本仓库工作区实际运行）

`npm test` 退出码 0。`node dist/test/sandbox.test.js` 的 TAP 输出：

```
ok 1 - resolves relative paths with . and ..
ok 2 - '..' clamps at the sandbox root instead of escaping
ok 3 - expands relative, absolute and chained symlinks inside the sandbox
ok 4 - rejects absolute symlink targets outside the sandbox
ok 5 - rejects relative symlink targets that climb out of the sandbox
ok 6 - checks the boundary at every expansion step (mid-chain escape)
ok 7 - detects symlink cycles (ELOOP)
ok 8 - enforces the expansion-count limit (EMLINK)
ok 9 - exists() returns a ticket for present paths and null for missing ones
ok 10 - exists() still surfaces boundary errors instead of returning null
ok 11 - open() accepts a ticket from exists() when nothing changed
ok 12 - ESTALE: swapping a link to an external target between check and open
ok 13 - ESTALE: swapping a link to a different internal file is also rejected
ok 14 - without a ticket the swapped external link is stopped by the boundary check
ok 15 - ESTALE: removing and recreating an entry invalidates the ticket
ok 16 - open() reports ENOENT for missing files and EISDIR for directories
# tests 16
# pass 16
# fail 0
```
