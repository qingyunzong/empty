# mvcc-store

单机离线 MVCC 键值存储（Node.js 22，仅用标准库），面向科研复现场景：
数据集持续被追加/修订时，用**快照隔离读事务**和**命名快照（标签）**锁定"某次分析看到的数据视图"。

## 设计

- **多版本**：每个键保留 `[(提交序号, 值)]` 版本链，版本号 = 单调递增的提交序号。
- **快照读**：`begin()` 在事务开始时固定快照序号，之后的提交对其不可见。
- **先写者胜**：写事务提交时，若其要写的键在快照之后被其他事务提交过，抛出
  `CONFLICT`，事务可安全重试（重新 begin 后重放写集）。
- **命名快照**：`tag(name, seq)` 把某个提交序号登记为可复现标签；
  `beginTag(name)` 按标签开启读事务，结果逐字节一致（值以 `Buffer` 存储，WAL 中 base64 编码）。
- **WAL 持久化**：每次提交/打标签先追加写 `wal.log` 并 `fsync`；崩溃恢复时重放全部记录，
  容忍末尾撕裂行。GC 后写入 `checkpoint` 记录（原子 tmp+rename）压缩 WAL。
- **GC**：`gc()` 默认只回收不被任何标签或活跃读事务引用的旧版本
  （保留每个键在回收地平线处可见的版本 + 更新的所有版本）。
  显式 `gc(beforeSeq)` 若地平线超过被引用的最小快照序号，拒绝并抛 `GC_REFUSED`。

## 错误约定

| 错误码 | 含义 |
| --- | --- |
| `CONFLICT` | 写事务提交时发现写-写冲突（先写者胜），可安全重试 |
| `NO_TAG` | 标签不存在（`beginTag` / `untag`） |
| `GC_REFUSED` | GC 试图回收仍被标签或活跃事务引用的版本，拒绝执行 |

## 库 API

```js
import { MvccStore } from './src/store.js';

const store = MvccStore.open('./data');

store.commit({ a: 'v1', b: Buffer.from([0, 255]) }); // 批量写，返回提交序号
store.tag('experiment-1');                            // 命名快照
store.commit({ a: 'v2' });

const tx = store.beginTag('experiment-1');            // 按标签读，逐字节一致
tx.get('a');                                          // Buffer 'v1'
tx.close();

const wtx = store.beginWrite();                       // 写事务
wtx.set('c', 'x');
wtx.commit();                                         // 冲突时抛 CONFLICT

store.gc();                                           // 安全回收
store.close();
```

## CLI

```sh
node bin/mvcc.js commit --db ./data a=1 b=hello [--del key]
node bin/mvcc.js snapshot --db ./data exp-1 [SEQ]
node bin/mvcc.js read --db ./data --tag exp-1 a
node bin/mvcc.js read --db ./data            # 最新视图，省略 key 则列出全部
node bin/mvcc.js tags --db ./data
node bin/mvcc.js untag --db ./data exp-1
node bin/mvcc.js gc --db ./data [--before SEQ]
```

错误以 `<CODE>: <message>` 写到 stderr，退出码非 0。

## 测试

运行 `node --test`。真实结果（2026-10-04，Node v22.22.1）：

```
ok 1 - acceptance 1: long read tx is stable across 5 concurrent commits
ok 2 - acceptance 2: tagged snapshot reads are byte-identical after later writes
ok 3 - first-writer-wins conflict returns CONFLICT and retry succeeds
ok 4 - missing tag raises NO_TAG
ok 5 - WAL recovery: tags and version chains survive close/reopen and crash
ok 6 - gc keeps tagged snapshots readable and refuses to collect referenced versions
ok 7 - acceptance 3: randomized ops with gc match a full-history reference model
ok 1 - cli: commit / snapshot / read --tag / gc round-trip

# tests 2 (files) / 8 (cases)
# pass 8
# fail 0
```

三个验收场景的覆盖方式：

1. **长读事务期间 5 次提交**：`begin()` 后连续 5 次 `commit()`，读事务内结果与
   `begin` 时逐字节一致，且看不到新提交的键（test 1）。
2. **打标签后继续修改**：标签后执行覆盖写、二进制写、删除，`beginTag` 读取与
   首次读取的字节完全相等（test 2）。
3. **GC 安全性**：固定种子的随机操作序列（提交/打标签/开读事务/关闭/GC，400 步），
   每一步与保留全部版本的参考模型对照所有标签与活跃读事务的读结果；
   GC 与崩溃恢复后所有标签快照仍可读（test 6、7）。

## 文件结构

- `src/store.js` — MVCC 核心（版本链、快照、冲突检测、WAL、恢复、GC）
- `src/cli.js` — CLI 命令实现（可在进程内调用，便于测试）
- `bin/mvcc.js` — 可执行入口
- `test/mvcc.test.js` — 库级验收测试（含随机对照模型）
- `test/cli.test.js` — CLI 端到端测试
