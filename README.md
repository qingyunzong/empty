# lot-genealogy

多工厂离线批谱系库与 CLI。纯 Node.js 22 标准库（`node:crypto` / `node:fs` / `node:util` / `node:test`），单机离线，无第三方依赖。

- 有向无环图：节点为批（lot），边为 consume/produce；操作捕获 `merge` / `split` / `relabel`（另有 `register` 登记原料批）。
- 校验：质量守恒（相对容差，默认 0.5%，可用 `--tolerance` 覆盖）、批状态（open/consumed、余量）、时间先后（Lamport ts）、循环拒绝。
- 双向同步：版本向量 `{site: seq}` 驱动，按条目 id 幂等去重；未知父批进入 pending，补全后自动收敛，不直接失败。
- 证书：SHA-256 哈希链（`head = H(head || ':' || H(entry))`），`verify` 可检测篡改、缺边、循环。
- 崩溃安全持久化：edge log 行级 fsync、snapshot tmp+rename、cert 先落盘后 manifest commit。

## CLI

```
lot-genealogy add --store D --register LOT:MASS [--ts N] [--site S]
lot-genealogy add --store D --op merge|split|relabel --in L:M ... --out L:M ...
lot-genealogy sync --store A --peer B        # 双向
lot-genealogy resume --store D               # 崩溃恢复
lot-genealogy prove --store D --lot L [--out cert.json]
lot-genealogy verify --cert cert.json [--store D]
```

stdout 为结果 JSON；stderr 为错误 JSON `{ok:false, error, code}`。退出码：`0` 成功，`2` 校验失败，`3` pending，`7` 证书失败，`1` 用法错误。

## 持久化故障点与恢复协议

| 故障点 | 写协议 | `resume` 恢复 |
|---|---|---|
| edge log fsync 前/后 | 整行写入 + `fsync` + 目录 fsync | 截断首条损坏/半行尾部，绝不出现半条边；已 fsync 的条目完整保留 |
| snapshot rename 前 | tmp 写入 + fsync + `rename` + 目录 fsync | 删除残留 `*.tmp`；snapshot 校验失败则从 log 重放重建 |
| cert manifest commit 后 | cert 文件原子落盘后才追加 manifest + fsync | manifest 有记录但 cert 缺失/损坏 → 丢弃记录；cert 存在但未 commit → 删除文件；重新 prove 幂等，不会双证书 |

## 测试（真实结果）

`node --test`，Node v22.22.1，2026-10-03 实跑：**31 个测试全部通过，0 失败**（6 个文件，总耗时约 5.5s）。

- `test/graph.test.js`（10）：合批守恒越界→码 2、分批越界、消费已耗尽批、余量不足、时间倒置、循环 relabel（A→B→A 与自环）、pending 补全收敛、重复条目幂等。
- `test/sync.test.js`（2）：双向同步版本向量收敛且幂等；跨站未知父批 pending 后经再次同步收敛。
- `test/cert.test.js`（6）：prove/verify 往返；篡改条目→码 7；删边→码 7；伪造合法哈希链的循环证书→码 7；pending 阻塞 prove→码 3；commit 幂等无双证书。
- `test/crash.test.js`（6）：三个故障点各向（撕裂写截断、tmp 残留清理、manifest/cert 双向对账），恢复后重新 prove 仅一份证书。
- `test/enumerate.test.js`（1）：n=2..8、每档 12 个随机 DAG（mulberry32 定种子），库内 DFS 与独立自底向上 DP 双实现枚举**所有**祖先路径逐条对照，并校验证书祖先集合一致性。
- `test/cli.test.js`（6）：端到端退出码 2/3/7 与 stderr JSON（沙箱禁止 spawn，经 CLI 的可注入 io 接口进程内驱动同一 `main`）。

```
# tests 6  # pass 6  # fail 0     （文件级；子测试合计 31）
```
