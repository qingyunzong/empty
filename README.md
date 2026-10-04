# wtx-store — 嵌套事务 KV 存储（气象站数据订正）

仅用 Node.js 22 标准库实现。订正批次可任意嵌套：子批次提交仅并入父批次，
最外层提交才写入 WAL 生效；任一层 abort 只回滚该层及其子层，兄弟子事务不受影响。
已提交的最外层事务支持 undo（生成逆向补偿事务写入 WAL）与 redo，
undo/redo 历史由 WAL 重建，崩溃恢复后保持。

## 结构

- `src/store.js` — 核心库：`Store` / `StoreError`
- `src/cli.js` — CLI（同时导出 `runCli(argv, dir)` 便于进程内测试）
- `test/store.test.js` — 验收场景 1–3、错误约定、随机对照测试
- `test/cli.test.js` — CLI 行为与错误码

## 设计要点

- **嵌套事务**：每个事务持有 `writes` 与 `inverse`（逆向日志，记录每个键首次写入前的值）。
  子事务 commit 把 `writes`/`inverse` 并入父事务；abort 丢弃整棵子树。
- **WAL 两段写入**：每条记录（commit/undo/redo）先写数据行并 `fsync`，再写
  `{kind:'end', id}` 完成标记并 `fsync`。恢复时只重放带完成标记的记录——
  崩溃只可能留下"完整生效"或"完全不存在"两种状态（场景 3）。
- **undo/redo**：undo 弹出 undo 栈顶事务，校验冲突后把逆向补偿事务写入 WAL 并应用，
  原事务压入 redo 栈；redo 反之。新的最外层 commit 清空 redo 栈。
  恢复时按 WAL 顺序重建 undo/redo 栈，历史跨崩溃保持。
- **冲突检测**：`undo(txId)` 指定非栈顶事务时，若其写过的键被后续提交覆盖，
  返回 `CONFLICT` 且不执行任何操作。
- **限制**：存在打开的事务时 undo/redo 返回 `TX_ACTIVE`（undo 作用于已提交历史，
  与参考模型的快照语义保持一致）。

## 错误约定

| 场景 | 错误码 |
| --- | --- |
| 无活跃事务 / 无可撤销历史时 undo | `NOTHING_TO_UNDO` |
| redo 栈为空时 redo | `NOTHING_TO_REDO` |
| abort/commit/set 已关闭事务 | `CLOSED` |
| undo 与后续新写冲突 | `CONFLICT`（不执行） |
| 有打开事务时 undo/redo | `TX_ACTIVE` |
| 事务不存在 | `NOT_FOUND` |

CLI 出错时向 stderr 输出 `ERROR <CODE> <message>` 并以退出码 1 终止。

## CLI

```sh
export WTX_DIR=.wtx          # 数据目录（WAL + 状态文件），默认 ./.wtx
node src/cli.js begin        # 开启最外层事务，打印 txN
node src/cli.js sub          # 在当前事务下开子事务
node src/cli.js set k v      # 在当前事务内写入
node src/cli.js get k        # 读取（当前事务视角）
node src/cli.js commit [txN] # 提交当前（或指定）事务
node src/cli.js abort  [txN] # 回滚当前（或指定）事务及其子树
node src/cli.js undo  [txN]  # 撤销最近（或指定）已提交事务
node src/cli.js redo         # 重做
node src/cli.js log          # 查看 undo/redo 栈
```

## 测试

```sh
node --test
```

真实运行结果（Node v22.22.1，2026-10-04）：

```
ok 1 - scenario 1: aborting the middle of 3 nesting levels removes only that layer
ok 2 - scenario 2: undo then redo restores the exact post-commit state
ok 3 - scenario 3: crash between undo WAL record and completion marker is all-or-nothing
ok 4 - error codes: NOTHING_TO_UNDO, CLOSED, CONFLICT
ok 5 - undo/redo history survives restart
ok 6 - random nested operations match a simple reference implementation
ok 1 - CLI: nested batch, undo/redo, log, get
ok 2 - CLI: abort of a sub-batch keeps the rest
ok 3 - CLI: error conventions
# tests 2
# pass 2
# fail 0
# duration_ms 8058.275593
```

说明：

- 场景 3 通过 `undo(null, { crashBeforeEnd: true })` 在完成标记前注入崩溃，
  重启后该 undo 完全不存在，且 redo 链可继续；`crashBeforeBegin` 覆盖记录未落盘的情形。
- 随机测试用 mulberry32(42) 生成 3000 步嵌套 begin/set/commit/abort/undo/redo/get，
  与快照式参考实现逐步比对 `get` 结果及最终提交态。
- 沙箱禁止 node 派生子进程，CLI 测试通过进程内调用 `runCli` 进行；
  每次调用重新从磁盘装载状态，等价于独立进程调用（CLI 本体已经 shell 冒烟验证）。
