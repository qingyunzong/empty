# ebr-chain

无菌灌装电子批记录（EBR）离线汇总与验证。Node.js 22，仅标准库，无外部密钥，
仅用 sha256 链保证完整性。单机离线，日志格式为 JSONL。

## 记录模型

每条记录（一行 JSON）：

```json
{
  "v": 1,
  "type": "step | deviation | tombstone | join | exit",
  "site": "S1",
  "gen": 1,
  "vc": { "S1": 3, "S2": 1 },
  "prev": "<本站上一条记录的 sha256 或 null>",
  "payload": { },
  "hash": "<除 hash 字段外的规范 JSON 的 sha256>"
}
```

- **前哈希**：`prev` 串起同一站点自身的链（多站点离线各自记账，合并成 DAG）。
- **向量因果**：`vc` 为向量时钟，跨站点表达 happens-before。
- **站点成员代次**：`gen` 单调不减；`exit` 记录携带 `payload.seal = {count, head}`，
  封存退出时本站链的长度与链头。
- **撤销（tombstone）**：`payload = {target, scope, reason}`，指向原记录并说明范围。
  撤销本身可被更高代次的撤销撤销（原记录恢复有效）；链本身不可改。
- **站点退出后**：`gen <= 退出代次` 且计数器超出 `seal.count` 的补录被拒绝（exit 16）；
  已封存的历史保留；以更高代次重新加入可继续记账。

## CLI

```sh
node bin/ebr.js append <log.jsonl> --site S1 --gen 1 --type step --payload '{"op":"fill"}'
node bin/ebr.js merge  <out.jsonl> <in1.jsonl> [in2.jsonl ...]
node bin/ebr.js verify <log.jsonl>
node bin/ebr.js export <log.jsonl> [--out cert.json]
```

- `append`：计算本站 `prev` 与合并视图下的 `vc`，追加一条记录并打印。
- `merge`：多份 JSONL 按哈希去重，输出确定性的因果拓扑序（可重放）。
- `verify`：打印证书并以退出码报告结论。
- `export`：导出证书 + 未被墓碑遮蔽的有效记录视图。

## 证书（verify / export 输出）

```json
{
  "status": "ok | unknown | broken | rejected",
  "head": "<全部记录哈希排序后的 sha256，与合并顺序无关>",
  "records": 12,
  "sites": ["S1", "S2"],
  "missing": [{ "kind": "prev|counters|causal|seal|tombstone-target", "..." : "..." }],
  "masked": [{ "hash": "...", "by": "<tombstone hash>", "scope": "...", "reason": "..." }],
  "effective": 11
}
```

- `missing`：缺失集（断开的 prev、计数器缺口、向量因果缺口、封存的链头缺席、
  墓碑目标缺席）。**缺失只标 `unknown`，绝不判不合规**，退出码仍为 0。
- `masked`：被墓碑遮蔽但仍完整保留、可审计的记录集合。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | ok 或 unknown（含缺失） |
| 15 | 断链：哈希不符、分叉、prev 指向链内错误位置、代次倒退、封存链头不符 |
| 16 | 低代次补录：退出封存后出现 `gen <= 退出代次` 且超出封存计数器的记录 |

## 测试

```sh
node --test
```

覆盖：三站点乱序合并可重放；撤销再撤销的确定边界；缺失摘要只列缺口不判失败；
随机 ≤9 步与独立链枚举对照（300 轮）；exit 15 / 16；CLI 端到端。
