# observatory-corrections

天文台观测更正登记系统：原始观测永不删除，更正以新记录追加并指向被更正记录，
形成更正链。仅使用 Node.js 22 标准库，单机离线运行。

## 存储引擎设计（`src/store.js`）

- **WAL（`wal.log`）**：每条更正事务是一行 JSON（`seq/id/target/value/corrects/t` +
  SHA-256 校验和），先 `writeSync` 追加并 `fsync`，然后才更新内存状态与二级索引。
  重放时逐行校验，遇到撕裂/损坏的尾部行即停止（该行属于未完成的崩溃写入）。
- **二级索引**：按目标名（`idx-target.json`：target → 最新记录）和按时间范围
  （`idx-time.json`：按 `(t, seq)` 排序的提交序列）两个索引，通过 tmp 文件 +
  rename 原子刷盘；每 50 条事务或 `close()` 时刷盘。
- **崩溃恢复**：WAL 是唯一事实来源。打开存储时重放 WAL 重建内存索引；
  `verify` 独立地从 WAL 重算两个索引并与磁盘索引文件比对，缺失/损坏/不一致时
  自动重建，保证索引与数据完全一致。
- **查询**：
  - `resolve(target)`：链尾 = 该目标所有记录中未被任何记录更正、seq 最大者。
  - `viewAt(target, t)`：当时视图 —— 只在 `t` 时刻之前（含）提交的记录上取链尾。
  - `chain(target)`：从原始观测沿"最新更正者"指针走到链尾。
  - `range(from, to)`：时间索引上的范围查询。
- **错误约定**：更正不存在的记录抛 `NO_TARGET`；沿被更正链向上检测到环状引用
  （或复用已存在的记录 id）抛 `CYCLE`，事务拒绝且不留痕迹。

## CLI

```bash
node cli.js correct  --data DIR --target M31 --value 4.0 [--corrects ID] [--id ID] [--time MS]
node cli.js resolve  --data DIR --target M31        # 链尾（最新有效值）
node cli.js view-at  --data DIR --target M31 --time 200
node cli.js chain    --data DIR --target M31        # 打印整条更正链
node cli.js range    --data DIR --from 0 --to 1000  # 时间范围查询
node cli.js verify   --data DIR                     # OK / REBUILT
```

退出码：`0` 成功，`2` NO_TARGET，`3` CYCLE，`64` 用法错误，`1` 其他错误。
`--value` 先按 JSON 解析，失败则按字符串存储；`--time` 缺省为 `Date.now()`。
更正记录缺省继承被更正记录的 target。

## 库 API

```js
import { openStore } from './src/store.js';
const store = openStore('data-dir');          // 重放 WAL，恢复索引
const a = store.commit({ target: 'M31', value: 'mag=4.0', t: 100 });
const b = store.commit({ corrects: a.id, value: 'mag=4.1', t: 200 });
store.resolve('M31');        // => b
store.viewAt('M31', 100);    // => a
store.verify();              // => { ok: true, rebuilt: false }
store.close();               // 刷盘索引并关闭 WAL
```

## 测试

```bash
node --test
```

测试覆盖三个验收场景及错误约定、索引损坏重建、CLI 端到端：

1. 更正链 A→B→C 后 `resolve` 返回 C，`view-at(B时刻)` 返回 B（含重启后重放）。
2. 索引刷盘前注入崩溃（`fixtures/crash-commit.mjs` 提交 3 条后 `process.exit(1)`），
   重启后 WAL 重放完整、`verify` 通过并重建索引。
3. 种子化随机 300 条更正（85% 更正既有记录，含分叉）与暴力扫描参考实现逐目标
   对照 `resolve` 及多个历史截点的 `viewAt`，并在重启后再次对照。

真实运行结果（Node v22.22.1，2026-10-02）：

```
✔ acceptance 1: chain A->B->C, resolve returns C, view-at(tB) returns B (39.569161ms)
✔ error contract: NO_TARGET for unknown record, CYCLE for cyclic reference (14.792326ms)
✔ acceptance 2: crash before index flush, verify passes after restart (767.601611ms)
✔ corrupt index files are rebuilt from the WAL (24.096339ms)
✔ acceptance 3: 300 random corrections match brute-force reference (155.95135ms)
✔ CLI: correct/resolve/view-at/chain/verify and error exit codes (10128.688494ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```
