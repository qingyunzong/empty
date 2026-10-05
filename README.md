# file-undo

编辑器风格的文件操作撤销库。TypeScript 编写，仅依赖 Node.js 内置模块
（`node:fs` / `node:path` / `node:crypto`），无第三方运行时依赖。

## 设计

- **前后摘要**：每个操作（create / write / delete / move）为每个受影响路径
  记录 before/after 快照：存在性 + SHA-256 摘要，精确字节备份在私有存储目录
  （`.undo-store/`）中。
- **撤销只接受当前后像**：撤销前校验磁盘实时状态与记录的 after 快照一致；
  若文件被外部修改（摘要不符）、丢失或多出，撤销被拒绝，文件保持原样。
- **批量撤销全检先生效**：`undoBatch(n)` 先按逆序在模拟状态图上校验整批
  （移动链中同一路径的前后衔接也能正确验证），任一外部修改 → 整批不生效，
  历史栈保留可重试。
- **移动链与覆盖备份**：move 是一等操作，链 `a→b→c` 可整批逆放/重放；
  写入或移动到已存在的目标时，目标的旧字节先备份，撤销时一并还原。
- **重放/逆放后核对**：undo（逆放）与 redo（重放）应用完毕后，按最终生效
  状态逐路径核对字节摘要与存在性，结果在 `BatchResult.verified` 中报告。

## API

```ts
import { FileUndoManager } from "./src/file-undo.ts";

const mgr = new FileUndoManager(".undo-store");
mgr.writeFile("a.txt", "v1");        // create（已存在则为 write，备份旧字节）
mgr.writeFile("a.txt", "v2");        // 覆盖：v1 被备份
mgr.moveFile("a.txt", "b.txt");      // 移动；目标已存在则备份目标
mgr.deleteFile("b.txt");             // 删除：字节被备份

mgr.undo();                          // 撤销最新一个操作
mgr.undoBatch(3);                    // 原子批量撤销：全检通过才生效
mgr.redo();                          // 重放
mgr.redoBatch(2);                    // 批量重放
// 返回 BatchResult { ok, applied, failures, verified }
```

## 测试

```sh
npm test        # tsc 编译到 dist/ 后用 node:test 运行
npm run typecheck
```

注：本机 Node v22.22.1 未内建类型擦除（`ERR_NO_TYPESCRIPT`），故测试前先由
全局 tsc 7.0.2 编译。离线环境无 `@types/node`，`types/node-shim.d.ts`
提供最小 ambient 声明，不影响运行时。

## 实际测试结果（2026-10-05，Node v22.22.1）

```
ok 1 - create -> undo removes file; redo restores exact bytes
ok 2 - overwrite keeps a backup of the target; undo restores old bytes
ok 3 - delete -> undo restores the deleted bytes
ok 4 - move chain a->b->c unwinds as an atomic batch and replays
ok 5 - move onto an existing file backs it up; undo restores both
ok 6 - undo refuses when the after-image no longer matches (external edit)
ok 7 - batch undo is all-or-nothing: one external edit blocks the whole batch
ok 8 - batch undo of a move chain detects tampering at any link
ok 9 - undo detects a missing file and an unexpected file
ok 10 - a new operation clears the redo stack
ok 11 - binary content round-trips byte-exact through undo/redo
ok 12 - full history: undo everything then redo everything, verified
# tests 12
# pass 12
# fail 0
# duration_ms 139.27234
```

`npm run typecheck`（tsc --noEmit，strict）通过，退出码 0。
