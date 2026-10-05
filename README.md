# editor-undo

基于快照摘要的编辑器文件操作撤销库。TypeScript 编写，仅使用 Node.js 内置模块
（`node:fs` / `node:crypto` / `node:path`），零运行时依赖。

## 核心机制

- **前后摘要**：每个文件操作（create / write / delete / move）在日志条目
  （`src/entry.ts`）中记录操作前后内容的 SHA-256 摘要；字节本体存入以摘要为键的
  内容寻址备份库（`src/store.ts`），被覆盖、被删除的内容都可据此恢复。
- **撤销只接受当前后像**：`undo()` 应用任何改动前，先比对磁盘当前状态与日志记录的
  后像（after-image）；不一致即抛出 `ExternalModificationError`，磁盘保持原样。
- **批量撤销全批预检**：`undo(n)` / `redo(n)` 先在内存虚拟视图上按逆序（撤销）或
  正序（重放）逐步校验整批 `n` 条目的全部前置状态；任一路径被外部修改，整批
  不生效，一个文件都不会被动到。
- **移动链**：`move A→B`、`move B→C` 作为链式条目，批量撤销时虚拟视图让后撤销的
  条目看到先撤销条目产生的中间状态，因此能逐链节还原到 `A`；重放则正向恢复。
- **覆盖目标备份**：`moveFile(from, to)` 若 `to` 已存在，先备份其字节（摘要记入
  条目的 `overwritten` 字段）再改名；撤销时恢复被覆盖的受害者，重放时要求受害者
  仍处于被还原的状态，否则拒绝。
- **重放/逆放后核对**：每批应用完毕后，重新读取所有触及路径，逐一核对字节摘要
  与存在性（路径），不符则抛出 `IntegrityError`；核对结果通过
  `BatchResult.verified` 返回。

## API

```ts
import { UndoManager } from './src/index.js';

const um = new UndoManager();
um.writeFile('a.txt', 'v1');      // 记录 create（含 after 摘要）
um.writeFile('a.txt', 'v2');      // 记录 write（before/after 摘要）
um.moveFile('a.txt', 'b.txt');    // 记录 move（覆盖目标自动备份）
um.deleteFile('b.txt');           // 记录 delete（字节已备份）

um.undo(2);          // 批量撤销 2 条：先全批预检，再逆放，再核对
um.redo(1);          // 重放 1 条：同样预检 + 核对
um.journal;          // 当前可撤销条目（含每条 before/after 摘要）
um.pendingUndo; um.pendingRedo;
```

错误类型：`ExternalModificationError`（预检失败，磁盘未动）、
`IntegrityError`（应用后核对失败）、`RangeError`（撤销/重放数量越界）。

## 测试

```sh
npm test     # tsc 类型检查并编译，然后 node --test 运行全部用例
```

`npm test` = `tsc -p tsconfig.json && node --test "dist/test/*.test.js"`。
本环境的 test runner 按文件粒度汇总（失败时退出码为 1，门禁有效）；
逐条用例明细可用 `node dist/test/undo-manager.test.js` 查看。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：tsc 编译零错误，`node --test` 汇总 `pass 1 / fail 0`，退出码 0。
逐条用例（`node dist/test/undo-manager.test.js`）实际输出：

```
ok 1 - records before/after digests for every operation
ok 2 - undo restores bytes and paths, redo replays them, both verified
ok 3 - undo only accepts the current after-image
ok 4 - batch undo is all-or-nothing when any path was externally modified
ok 5 - move chains revert link by link and replay forward again
ok 6 - overwritten move targets are backed up and restored on undo
ok 7 - redo rejects when a restored overwrite victim was externally modified
ok 8 - delete undo restores bytes; an externally recreated file blocks it
ok 9 - a new operation clears the redo stack
ok 10 - batch undo of mixed operations verifies every byte and path afterwards
# tests 10
# pass 10
# fail 0
```

## 目录结构

- `src/digest.ts` — SHA-256 摘要
- `src/store.ts` — 内容寻址备份库
- `src/entry.ts` — 日志条目类型（create/write/delete/move）
- `src/errors.ts` — `ExternalModificationError` / `IntegrityError`
- `src/undo-manager.ts` — `UndoManager`：操作记录、批量预检、逆放/重放、事后核对
- `test/undo-manager.test.ts` — 10 个用例（`node:test` + `node:assert`）
- `types/node.d.ts` — 所用 node 内置模块的最小类型声明（环境无网络，无法安装 @types/node）
