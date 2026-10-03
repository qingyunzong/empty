# observatory-replica

观测台站网复制库 + CLI：成员变更（join/leave）、quorum 读写、反熵修复（repair）。
Node.js 22，仅标准库，测试用 `node:test`。

## 模型

- **成员表按 epoch 递增**：每次 join/leave（新成员或 tombstone 再加入）epoch +1；
  重复 join 幂等，不推进 epoch。
- **写**：`write` 需携带当前 epoch（否则 `EPOCH_MISMATCH`），且发起者必须是
  active 成员（否则 `NOT_MEMBER`）；可达 active 成员数 ≥ 多数派才提交，
  否则 `QUORUM_FAIL` 且不留痕迹（未确认值永远不会在后续可见）。
- **读**：返回 quorum 证书 `{epoch, signers, vector}`，value 为证书覆盖日志中
  因果最后的值（并发写按 `(origin, seq)` 确定性决胜）。
- **leave**：成员转为 tombstone，不再计票、不能读写，但日志与成员历史保留可审计。
- **repair**：反熵。按 version vector 缺口把缺失 entry 按序补到对端；
  只追加、不重排，不改变已确认的因果序。修复后各节点可见值与暴力全量拷贝一致。
- **分区模拟**：链路矩阵模拟单进程内消息丢弃；多数派侧可继续读写，
  少数派侧 `QUORUM_FAIL`，heal + repair 后恢复。

## CLI

```sh
node bin/replica.js <<'JSONL'
{"cmd":"join","node":"n1"}
{"cmd":"join","node":"n2"}
{"cmd":"join","node":"n3"}
{"cmd":"write","node":"n1","key":"temp","value":21.5,"epoch":3}
{"cmd":"read","node":"n2","key":"temp","epoch":3}
{"cmd":"partition","groups":[["n1","n2"],["n3"]]}
{"cmd":"heal"}
{"cmd":"repair"}
{"cmd":"leave","node":"n3"}
{"cmd":"status"}
JSONL
```

每行一个 JSON 命令，stdout 每行一个结果：
`{"ok":true,"result":{...}}` 或 `{"ok":false,"error":"NOT_MEMBER|EPOCH_MISMATCH|QUORUM_FAIL",...}`。

## 测试

```sh
node --test
```
