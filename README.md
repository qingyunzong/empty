# obs-store

嵌入式事务型键值存储，用于物理实验室管理观测记录（目标名 → 测量值，支持反复更正并保留全部历史版本）。仅使用 Node.js 22 标准库，单机离线运行。

## 特性

- **事务**：`begin` / `put` / `delete` / `commit` / `abort`
- **MVCC 快照隔离**：读事务看到其 `begin` 时刻的快照；写事务提交时若其写集与已提交的并发事务写集相交（first-committer-wins），提交失败并返回 `CONFLICT`
- **WAL 持久化**：所有写先落 append-only 日志；提交记录带 CRC-32 校验和
- **崩溃恢复**：启动时重放 WAL；尾部半条记录（崩溃点）自动截断并继续；无提交标记的事务数据不可见
- **CLI**：`init` / `put` / `get` / `del` / `scan` / `history`，`get`/`scan` 支持 `--at <version>` 读历史快照

## 设计

### WAL 记录格式

每条记录：`[4B 载荷长度][4B 载荷 CRC-32][JSON 载荷]`，类型：

- `{t:"put", txn, key, value}` / `{t:"del", txn, key}` — 事务的写记录
- `{t:"commit", txn, version, checksum}` — 提交标记；`checksum` 为该事务全部写记录载荷的链式 CRC-32
- `{t:"abort", txn}` — 中止标记

### 提交协议（两阶段）

1. 冲突检测：写集中任一键的最后提交版本 > 本事务快照版本 → `CONFLICT`
2. 追加全部写记录并 `fsync`
3. **故障注入点**（环境变量 `OBS_STORE_FAULT=after-data-fsync`，用于崩溃测试）
4. 追加提交记录并 `fsync` —— 这是原子提交点

### 恢复

- 顺序解析 WAL；遇到长度/校验和非法或截断的尾部记录 → 在该偏移处截断文件并继续
- 有提交记录且校验和匹配的写记录才生效；崩溃遗留的无提交标记写记录自动不可见
- 事务号取 WAL 中最大值 + 1，避免重启后事务号复用导致校验和混淆

### MVCC

内存中每个键维护按版本递增的 `{version, value|null}` 列表（`null` 表示删除）。版本号全局单调递增，即提交记录的 `version`。快照读 = 对每个键取 `version <= 快照版本` 的最新条目。

## 使用

```bash
node src/cli.js init ./db
node src/cli.js put ./db vega 'mag=0.03'        # -> v1
node src/cli.js put ./db vega 'mag=0.04'        # 更正 -> v2
node src/cli.js get ./db vega                   # -> mag=0.04
node src/cli.js get ./db vega --at 1            # 历史快照 -> mag=0.03
node src/cli.js scan ./db --prefix obs/
node src/cli.js del ./db vega
node src/cli.js history ./db vega               # 全部版本，含 <deleted>
```

库 API：

```js
const { Store } = require('./src/store');
const store = Store.open('./db');
const txn = store.begin();
txn.put('vega', 'mag=0.04');
txn.commit(); // 冲突时抛出 err.code === 'CONFLICT'
store.get('vega', { at: 1 });
store.close();
```

## 错误约定

| 场景 | 错误码 | CLI 退出码 |
|---|---|---|
| 键不存在 | `NOT_FOUND` | 3 |
| 参数非法 | `INVALID` | 2 |
| 写冲突 | `CONFLICT` | 4 |
| 其他错误 | — | 1 |

错误码打印到 stderr，退出码非零。

## 测试

```bash
node --test
```

覆盖验收场景：

1. **并发写冲突**（`test/mvcc.test.js`）：两个并发写事务改同一键，后提交者 `CONFLICT`；另含快照隔离、读己之写、删除/中止语义等 8 个子测试
2. **提交中途崩溃**（`test/recovery.test.js`）：子进程在 `fsync` 后、写提交标记前注入故障退出（退出码 77），重启后该事务不可见、之前事务完整；另含尾部半条记录截断、提交校验和损坏、abort 记录恢复共 4 个子测试
3. **模型对照**（`test/model.test.js`）：200 个键、500 个随机操作（多操作事务 + 随机历史版本全键空间快照读），与内存 Map 参考模型逐键对照，并验证重启重放后状态一致
4. **CLI 端到端**（`test/cli.test.js`）：全部子命令、`--at`/`--prefix`、`NOT_FOUND`/`INVALID` 退出码

### 真实测试结果（2026-10-03，Node v22.22.1）

```
$ node --test
ok 1 - test/cli.test.js      (3 子测试)
ok 2 - test/model.test.js    (1 子测试)
ok 3 - test/mvcc.test.js     (8 子测试)
ok 4 - test/recovery.test.js (4 子测试)
# tests 4
# pass 4
# fail 0
```

共 16 个子测试，全部通过。
