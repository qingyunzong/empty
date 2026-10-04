# lot-genealogy

离线多工厂批次谱系库与 CLI。有向无环图：节点为批（lot），边为 consume/produce；
变更捕获 merge / split / relabel，校验质量守恒容差、批次状态、时间先后与无环。
仅依赖 Node.js 22 标准库与 `node:test`，单机离线运行。

## 数据模型

- **lot**：`{id, mass, unit, status(open|closed|consumed), createdAt, site, seq}`
- **event**：`{id, op(merge|split|relabel), inputs[], outputs[], ts, site, seq}`，
  `id = sha256(canonical(body))`，天然幂等
- **edge**：由事件展开（merge：每个输入→输出；split/relabel：输入→每个输出），
  `edgeId = sha256(eventId, from, to)`，重复边幂等

## 校验（退出码 2）

- 质量守恒：`|Σin − Σout| ≤ max(tol, tol·max(Σin,Σout))`，`--tol` 可调（默认 1e-9）
- 批次状态：`closed` 不可投料；累计消耗不得超过批次余量（防重复消耗）
- 时间先后：事件 `ts` 不得早于输入批 `createdAt`
- 无环：新边 `from→to` 若 `to` 可达 `from`（含 relabel 回环）则拒绝

## 同步与 pending（退出码 3）

- 每个站点维护版本向量 `vv[site] = max(seq)`；双向 sync 按 VV 差量交换记录
- 重复记录/边按内容哈希幂等去重，重复 sync 零增量
- 未知父批的事件进入 `pending`，不失败；父批到达后自动补全收敛
- `resume` 重放恢复并重解 pending，仍有 pending 时退出码 3

## 证书（退出码 7）

- `prove` 收集目标批全部祖先批/事件/边（含分批兄弟批作为 boundary 证据），
  按规范 JSON 排序后做 SHA-256 哈希链，`certId = chain`
- 证书清单 `manifest.jsonl` 逐条哈希链（`prev` 链接），按 `certId` 去重
- `verify` 检测：篡改（哈希链不符）、缺边（事件端点/守恒/可达性/本地交叉核对）、
  循环（拓扑排序）

## 持久化与故障恢复

- `log.jsonl`：追加式，每行 `{seq, rec, sum}` 校验和；写后 fsync。
  恢复时截断撕裂尾部——绝不出现半条边
- `snapshot.json`：tmp 写入 + fsync + 原子 rename；rename 前崩溃保留旧快照，
  日志重放补齐
- `certs/<id>.json` 先落盘，manifest 后提交；commit 后崩溃重试幂等，
  恢复时清理孤儿证书——绝不出现双证书
- 故障注入（测试用）：`LOT_FAULT=edge-pre-fsync|edge-post-fsync|snapshot-pre-rename|cert-post-commit`，
  `LOT_FAULT_TEAR=1` 模拟撕裂写

## CLI

```
lot-genealogy add --dir D --site S --lot L --mass M [--unit kg] [--ts T] [--status open]
lot-genealogy add --dir D --site S --op merge|split|relabel --in A:50,B:50 --out C:100 [--ts T] [--tol 1e-9]
lot-genealogy sync --dir A --with B
lot-genealogy resume --dir D
lot-genealogy prove --dir D --lot L [--out cert.json]
lot-genealogy verify --cert cert.json [--dir D]
```

错误以 JSON 写 stderr：`{"ok":false,"code":N,"error":...}`。
退出码：`0` 成功，`1` 其他，`2` 校验失败，`3` pending，`7` 证书失败。

## 测试

```
node --test
```
