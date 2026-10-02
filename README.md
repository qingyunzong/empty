# wx-correction-store

气象站数据订正存储：支持**嵌套事务**、**undo/redo**、**WAL 崩溃恢复**的键值库与 CLI。
纯 Node.js 22 标准库实现，无第三方依赖，单机离线运行。

## 语义

- **嵌套事务**：`store.begin()` 开根事务，`tx.begin()` 开子事务，可任意嵌套。
  子事务 `commit()` 只把写入并入父事务；只有最外层 `commit()` 才写 WAL 并生效。
- **分层回滚**：任一层 `abort()` 只丢弃该层及其子层的写入，兄弟子事务不受影响。
- **undo/redo**：已提交的最外层事务可 `undo()`——生成一个逆向补偿事务写入 WAL；
  `redo()` 重新应用。undo/redo 历史本身也持久化在 WAL 中，崩溃恢复后保留。
- **崩溃原子性**：事务先写 `begin`+`set` 记录并 fsync，最后写 `commit` 标记并 fsync。
  恢复时没有 commit 标记的事务（包括 undo 补偿事务）整体丢弃——要么完整生效，要么完全不存在。
  WAL 末尾的撕裂行（crash mid-write）在回放时被容忍。

## 错误约定

| 场景 | 错误码 |
| --- | --- |
| undo 栈为空时 `undo` | `NOTHING_TO_UNDO` |
| redo 栈为空时 `redo` | `NOTHING_TO_REDO` |
| 对已关闭（已提交/已回滚）事务 `abort`/`commit`/`set` | `CLOSED` |
| undo/redo 与后续新写冲突 | `CONFLICT`（不执行，状态不变） |

冲突判定：`undo(txId)` 要求目标事务写过的每个键的当前值仍等于该事务写入的值；
否则说明有后续事务改动了这些键，返回 `CONFLICT`。

## 库用法

```js
import { Store } from './src/store.js';

const store = new Store('./wxdata');
const batch = store.begin();        // 订正批次
batch.set('station.temp', 20.5);
const sub = batch.begin();          // 子批次
sub.set('station.temp', 21.1);
sub.commit();                       // 仅并入父事务
batch.commit();                     // 最外层提交：写 WAL、生效
store.undo();                       // 逆向补偿事务写入 WAL
store.redo();
store.close();
```

## CLI

```
node cli.js <command>        # 数据目录由 WX_DIR 指定，默认 ./wxdata
  begin                      开根事务（订正批次）
  sub                        开当前事务的子事务
  set <key> <value>          写入订正值（value 按 JSON 解析，失败按字符串）
  del <key>                  删除键
  commit                     提交当前事务（子事务并入父事务，根事务落 WAL）
  abort                      回滚当前事务及其子事务
  undo [txId]                撤销已提交事务（默认最近一个）
  redo [txId]                重做（默认最近被撤销的）
  log                        打印已提交事务历史与 undo/redo 栈
  get <key>                  读键（已提交状态叠加当前事务链的未提交写入）
```

错误以 `<CODE>: <message>` 打印到 stderr，退出码 1。
未提交的事务树保存在 `<dir>/session.json`，因此 begin/sub/commit 可跨进程调用。

示例：

```
$ node cli.js begin && node cli.js set temp 20.5 && node cli.js sub \
  && node cli.js set temp 21.1 && node cli.js commit && node cli.js commit
tx 1
ok
tx 2 (child of 1)
ok
tx 2 merged into tx 1
tx 1 committed
$ node cli.js undo && node cli.js get temp && node cli.js redo && node cli.js get temp
undone by tx 3
(unset)
redone by tx 4
21.1
$ node cli.js log
tx 1 kind=normal sets={"temp":21.1}
tx 3 kind=undo target=1 sets={"temp":"<deleted>"}
tx 4 kind=redo target=1 sets={"temp":21.1}
undoStack=[1] redoStack=[]
```

## 测试

```
node --test
```

覆盖验收场景：

1. **三层嵌套回滚中间层**（`test/nested.test.js`）：仅该层及其子层写入消失，
   兄弟子事务与父层写入保留。
2. **提交后 undo 再 redo**（`test/undo-redo.test.js`）：redo 后键值与提交后完全一致
   （含删除的逆向补偿）。
3. **undo 写 WAL 后、commit 标记前注入崩溃**（`test/crash.test.js`）：通过
   `store.hooks.beforeCommitMarker` 在 undo 数据记录 fsync 后、commit 标记前注入崩溃，
   重启后该 undo 完全不存在（状态与 undo/redo 栈均未变），且 redo 链可继续；
   commit 标记落盘后的崩溃则 undo 完整生效。
4. **随机对照**（`test/random.test.js`）：40 个种子 × 每种子 250 步随机操作
   （嵌套 begin/commit/abort/set/del/get/undo/redo，并随机关闭重开存储以走 WAL 恢复），
   每步后与简单参考实现（纯内存 Map 模型）比对已提交状态、undo/redo 栈与错误码。

### 真实测试结果（2026-10-03，Node v22.22.1，linux x64）

`node --test` 输出摘要：

```
ok 1 - test/cli.test.js        # 4/4 通过
ok 2 - test/crash.test.js      # 4/4 通过
ok 3 - test/nested.test.js     # 4/4 通过
ok 4 - test/random.test.js     # 1/1 通过（40 种子 × 250 步）
ok 5 - test/undo-redo.test.js  # 5/5 通过
# tests 5
# pass 5
# fail 0
```

共 18 个测试全部通过。

## 文件结构

- `src/wal.js` — 追加式 WAL（JSON 行，fsync，容忍撕裂尾行）
- `src/store.js` — `Store` / `Transaction`：嵌套事务、undo/redo、WAL 回放恢复
- `cli.js` — CLI（同时导出 `runCli(argv, dir)` 供测试在进程内调用）
- `test/` — node:test 测试
