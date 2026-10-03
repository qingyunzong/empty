# mvcc-store

单机离线 MVCC 键值存储（Node.js 22，仅标准库），面向科研复现场景：
数据集持续被追加/修订，复现任务可以通过**命名快照（标签）**锁定"某次分析看到的数据视图"，
之后任何时候按标签读取，结果逐字节一致。

## 设计

- **多版本**：每个键保留一条版本链，版本号 = 提交序号（单调递增的 `seq`）。
- **快照隔离读**：`beginRead()` 在事务开始时固定快照序号，之后的提交对其不可见；
  `beginRead({ tag })` 按标签登记时的序号读取。
- **先写者胜（first-writer-wins）**：写事务 `commit` 时检查写集合中的每个键，
  若有其他事务在本事务开始后提交过该键的更新版本，则整个提交失败并抛出
  `CONFLICT`，不落地任何写入，可安全重试（`store.transact(fn)` 自动重试）。
- **命名快照**：`snapshot(name)` 把当前提交序号登记为标签，并追加到 WAL。
- **WAL 持久化**：所有提交（含删除墓碑）与标签以 JSON Lines 追加写入
  `<db>/wal.log`，每条记录写后 `fsync`；恢复时截断末尾撕裂记录（torn write）。
  GC 后将存活版本重写为 checkpoint（临时文件 + `rename` 原子替换）。
- **GC**：`gc(beforeSeq)` 回收不被任何**活跃读事务**、**标签**或当前状态引用的旧版本；
  若 `beforeSeq` 越过最老的受保护快照序号，拒绝并抛出 `GC_REFUSED`。

## 错误约定

| 错误码       | 含义                                             | CLI 退出码 |
| ------------ | ------------------------------------------------ | ---------- |
| `CONFLICT`   | 写冲突（先写者胜），可安全重试                   | 2          |
| `NO_TAG`     | 标签不存在                                       | 3          |
| `GC_REFUSED` | GC 试图回收被标签/活跃事务引用的版本，拒绝执行   | 4          |
| 用法错误     | 参数缺失/非法                                    | 1          |

## 库 API

```js
import { MVCCStore } from './src/mvcc.js';

const store = MVCCStore.open('./mydb');

// 批量写（自动重试 CONFLICT）
store.transact((tx) => {
  tx.set('gene/brca1', Buffer.from('...'));
  tx.delete('tmp/scratch');
});

// 命名快照：锁定当前数据视图
store.snapshot('exp-2026-10-03');

// 之后数据继续变化……
store.transact((tx) => tx.set('gene/brca1', 'mutated'));

// 复现任务按标签读取，逐字节一致
const tx = store.beginRead({ tag: 'exp-2026-10-03' });
for (const [key, value] of tx.entries()) { /* key, Buffer */ }
tx.close();

// 回收无引用的旧版本（被标签/活跃读事务引用的版本会保留；
// 越过保护线会抛 GC_REFUSED）
store.gc();

store.close();
```

## CLI

```console
$ node bin/mvcc.js commit --db ./db --set alpha=1 --set beta=2   # 或位置参数 alpha=1
committed seq=1
$ node bin/mvcc.js snapshot --db ./db release-1
snapshot release-1 seq=1
$ node bin/mvcc.js commit --db ./db alpha=99
committed seq=2
$ node bin/mvcc.js read --db ./db --tag release-1 alpha
1
$ node bin/mvcc.js read --db ./db alpha
99
$ node bin/mvcc.js gc --db ./db            # 有标签保护时拒绝
GC_REFUSED: gc horizon 2 would reclaim versions referenced by a tag or active read transaction (oldest protected seq 1)   # 退出码 4
$ node bin/mvcc.js read --db ./db --tag nope k
NO_TAG: no such snapshot tag: nope         # 退出码 3
```

## 测试

运行：

```console
$ node --test
```

真实结果（Node v22.22.1，本仓库工作区，2026-10-03）：

```text
✔ test/cli.test.js
✔ test/mvcc.test.js
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

逐条明细（`node test/mvcc.test.js` / `node test/cli.test.js`）：

```text
ok 1 - acceptance 1: long read txn is stable across 5 commits
ok 2 - acceptance 2: tagged snapshot reads are byte-identical after later writes
ok 3 - write conflict: first-writer-wins, CONFLICT is safe to retry
ok 4 - unknown tag raises NO_TAG
ok 5 - gc refuses to reclaim versions referenced by tags or active readers
ok 6 - gc with no tags/readers collects old versions, keeps current state
ok 7 - crash recovery: tags and version chains survive reopen
ok 8 - recovery truncates a torn trailing WAL record
ok 9 - gc checkpoint persists: tags remain readable after gc + reopen
ok 10 - acceptance 3: randomized ops + gc match a keep-everything reference model

ok 1 - cli: commit / snapshot / read --tag / gc workflow
ok 2 - cli: read with unknown tag exits 3 with NO_TAG
ok 3 - cli: usage errors exit 1
ok 4 - cli: data persists across separate runCli invocations (WAL on disk)
ok 5 - cli: bin/mvcc.js runs as a real subprocess # SKIP child process pipes are blocked in this environment
```

说明：

- **验收场景 1**（长读事务期间 5 次提交，读结果不变）→ `acceptance 1` 测试。
- **验收场景 2**（打标签后继续修改，按标签读取与首次读取逐字节一致，含二进制值）→ `acceptance 2` 测试。
- **验收场景 3**（GC 后所有标签快照仍可读；600 步确定性随机操作序列 —— 提交/打标签/
  并发读事务/GC —— 与"全量保留版本"的参考模型逐步对照，并在模拟崩溃重开后再次对照）
  → `acceptance 3` 测试。
- 子进程冒烟测试在本沙箱中因子进程管道被拦截而 SKIP；CLI 的完整行为由
  进程内 `runCli` 测试覆盖（同一入口逻辑，`bin/mvcc.js` 仅为薄封装）。
  在正常环境中该测试会真实 spawn `node bin/mvcc.js` 执行。

## 文件结构

```text
src/mvcc.js   核心库：MVCCStore / ReadTxn / WriteTxn / WAL / GC
src/cli.js    CLI 逻辑（runCli，可进程内调用）
bin/mvcc.js   CLI 入口（薄封装）
test/         node:test 测试
```
