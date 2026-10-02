# dcdstore

面向论文引用的数据集版本化键值存储：发布即冻结，内容寻址证书保证永久可复现。
Node.js 22，仅标准库，`node:test` 测试，单机离线。

## 设计

- **快照隔离事务**：`begin()` 开启草稿事务，可读写（读己之写 + 已提交状态）；
  `commit()` 时校验写集，获得单调递增版本号（1, 2, 3, …）。
- **发布冻结**：`publish(version)` 将该版本冻结为发布态，生成内容寻址证书——
  对全量键值按字典序排序后的规范形式（`json(key)=json(value)` 逐行）计算 SHA-256。
  证书落盘于 `certs/<sha256>.json`，内含版本号与完整快照。
- **FROZEN 约束**：任何写事务的写集若触及任一已发布版本包含的键，`commit` 返回
  `FROZEN`，写入不生效；未涉及的键可正常写入。
- **按版本/证书读取**：`get --version N` / `get --cert <hash>` 读取历史发布版，
  输出为确定性的规范字节流，与发布时刻逐字节一致。
- **WAL 与崩溃恢复**：所有事务提交与发布事件追加写入 `wal.log`（写后 fsync）。
  发布协议为「先落证书、后记 WAL」；恢复时重放 WAL，凡 WAL 发布记录没有对应
  证书文件的（发布中途崩溃）一律丢弃，该版本保持草稿态，可重新发布。
  WAL 尾部撕裂行在恢复时被截断忽略。
- **错误约定**：读不存在版本 `NO_VERSION`；证书与快照不匹配 `TAMPER`；
  写触及已发布键 `FROZEN`。

## 数据目录布局

```
.dcdb/
  wal.log            # JSON 行：{type:'commit',version,writes} / {type:'publish',version,cert}
  certs/<sha256>.json  # {version, cert, snapshot}（原子写入 + fsync）
  pending.json       # CLI 未提交的草稿事务（put 暂存）
```

## CLI 用法

```bash
node src/cli.js [--dir <数据目录>] <command>   # 目录默认 $DCDB_DIR 或 ./.dcdb

node src/cli.js put title "paper-a"   # 暂存写入（草稿事务）
node src/cli.js put year 2026
node src/cli.js commit                # 提交 -> 输出版本号，如 "committed version 1"
node src/cli.js publish 1             # 冻结 v1 -> 输出证书哈希
node src/cli.js get --version 1       # 按版本读取（规范字节流）
node src/cli.js get --cert <sha256>   # 按证书读取，输出与发布时逐字节一致
node src/cli.js verify --version 1    # 校验证书 -> OK，否则 ERROR TAMPER
node src/cli.js verify --cert <sha256>
```

错误以 `ERROR <CODE>: ...` 输出到 stderr，退出码非 0。

## 库 API

```js
import { DCDB } from './src/db.js';

const db = DCDB.open('.dcdb');
const tx = db.begin();
tx.put('key', 'value');
const version = tx.commit();          // 写集触及已发布键时抛 DBError(code='FROZEN')
const { cert } = db.publish(version); // 冻结并返回内容寻址证书
db.get({ version });                  // -> Map
db.get({ cert });                     // -> Map，与发布时逐字节一致
db.verify({ version });               // 证书不匹配抛 DBError(code='TAMPER')
```

## 崩溃注入（测试用）

环境变量 `DCDB_CRASH_AT=before-cert|before-wal` 在发布协议对应阶段模拟断电
（立即退出，不清理），用于验证恢复语义。

## 测试结果（真实运行记录）

`node --test`，Node.js v22.22.1，2026-10-03 运行：

```
ok 1 - scenario 1: publishing v3 freezes its keys; unrelated keys stay writable
ok 2 - scenario 2: crash mid-publish (cert not on disk) leaves version as draft, re-publish works
ok 3 - scenario 3: 10 consecutive publishes, sampled keys match publish-time snapshots
ok 4 - error conventions: NO_VERSION and TAMPER
ok 5 - CLI end-to-end: put/commit/publish/get round trip
# tests 1  (test/db.test.js，含上述 5 个子测试)
# pass 1
# fail 0
```

覆盖三个验收场景：

1. 发布 v3 后修改其中键返回 `FROZEN`，未涉及键可正常写入，且重启后冻结约束依然生效；
2. 发布中途注入崩溃（`DCDB_CRASH_AT=before-cert`，证书未落盘），重启后该版本保持
   草稿态，可重新发布，发布后冻结约束生效、`verify` 通过；
3. 连续发布 10 个版本，每个版本随机抽样键与发布时刻快照参考逐一对照一致，
   按版本号与按证书两种读取路径输出逐字节相同，证书哈希复核一致。
