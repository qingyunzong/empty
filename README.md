# audit-interval-service

审计区间集合服务。Node.js 22、仅标准库、`node:test`、单机离线。

- 区间模型：半开整数区间 `[start, end)`。相邻边界 `[0,5)` 与 `[5,9)` **不重叠**（`start < b.end && b.start < a.end` 严格判定），规范化时合并为 `[0,9)`。
- 四类区间：`VALID`（交易有效）、`FROZEN`（冻结）、`EXEMPT`（免审）、`PENDING`（未知来源）。
- 未知来源区间一律标 `PENDING`，只作待确认标记，**不当作不可满足**（不报错、不阻断导入）。
- 每次批量导入 / 补丁 / 撤销都产生防篡改证书（SHA-256 哈希链）：含输入摘要 `inputDigest`、操作序列 `ops`、输出区间哈希 `stateHash`，并通过 `prevHash` 链接成链。
- 更正采用反向区间补丁（`remove` + `add`）：新证书记录 `supersedes`（旧证书 id）与 `invalidationReason`（旧证书失效原因），`verify` 重放整条链证明新证书覆盖范围 = 旧状态 − remove + add。
- 错误码：`E_INTERVAL`（非法区间）、`E_PATCH`（补丁非法）、`E_CERT`（证书篡改/链断裂）、`E_UNKNOWN`（未知类型/操作）。

## 结构

- `src/intervals.js` — 区间代数：`normalize` / `union` / `intersect` / `difference` / `gaps` / `containsPoint`
- `src/registry` 即 `src/service.js` — `AuditService`：批量导入、点查询归属、空洞/重叠报告、补丁与撤销
- `src/cert.js` — 证书签发与 `verifyChain`（从创世状态重放全部操作并逐环校验哈希链）
- `src/canon.js` — 规范化 JSON（键排序）+ SHA-256
- `src/cli.js` / `bin/cli.js` — CLI（状态持久化到 `AUDIT_STATE_FILE`，默认 `./audit-state.json`）
- `test/` — `node --test`

## 运行测试

```
$ node --test
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3163.971171
```

验收对照（见 `test/`）：

1. 相邻边界不重叠 — `test/intervals.test.js` “adjacent boundaries [0,5) and [5,9) do not overlap”
2. 补丁撤销后空洞恢复 — `test/service.test.js` “reverting a patch restores the gaps”
3. 篡改一个端点被证书检出 — `test/service.test.js` “tampering with one endpoint is detected by the certificate”（改 `ops` 中端点 / 改 `stateHash` / 断 `prevHash` 三种均抛 `E_CERT`）
4. 随机小区间与 O(n²) 参考并交差对照 — `test/intervals.test.js` “random small intervals match O(n^2) reference”（种子固定 PRNG，300 轮，按整数点集对照）

## CLI 实录（真实输出）

```
$ export AUDIT_STATE_FILE=/tmp/readme-demo2/state.json
$ cat batch1.json
[
  {"op":"add","kind":"VALID","intervals":[[0,5],[10,15]]},
  {"op":"add","kind":"FROZEN","intervals":[[3,4]]},
  {"op":"add","kind":"vendor-feed-x","intervals":[[40,50]]}
]
```

批量导入（未知来源 `vendor-feed-x` 被标为 `PENDING`）：

```
$ node bin/cli.js import batch1.json
{
  "id": "cert-0001",
  "seq": 1,
  "prevHash": "GENESIS",
  "type": "import",
  "inputDigest": "ca4fbe8b56d2f59f7b912012fe56ae50aaaba71655c6a6b29056f8af6d63e63a",
  "ops": [
    { "op": "add", "kind": "VALID", "intervals": [{ "start": 0, "end": 5 }, { "start": 10, "end": 15 }] },
    { "op": "add", "kind": "FROZEN", "intervals": [{ "start": 3, "end": 4 }] },
    { "op": "add", "kind": "PENDING", "intervals": [{ "start": 40, "end": 50 }] }
  ],
  "stateHash": "e9033ecd890a4b8eab7935a037014604b244d0745b8ee3ac717561c146b3b6c1",
  "hash": "1c06a3013a65f7673ee6cecb0df39f78e128476fcf53c30096d16041b3c57f8e"
}
```

点查询归属（优先级 `FROZEN > EXEMPT > VALID > PENDING`）：

```
$ node bin/cli.js query 3
{ "point": 3, "kinds": ["VALID", "FROZEN"], "status": "FROZEN" }
$ node bin/cli.js query 45
{ "point": 45, "kinds": ["PENDING"], "status": "PENDING" }
$ node bin/cli.js query 7
{ "point": 7, "kinds": [], "status": "UNCOVERED" }
```

空洞/重叠报告：

```
$ node bin/cli.js report 0 15
{
  "domain": { "start": 0, "end": 15 },
  "gaps": [{ "start": 5, "end": 10 }],
  "overlaps": [{ "kinds": ["VALID", "FROZEN"], "intervals": [{ "start": 3, "end": 4 }] }],
  "pending": []
}
```

反向补丁（证明旧证书失效原因与新证书覆盖范围）：

```
$ cat patch1.json
{"patchId":"p1","reason":"correction: freeze window mis-registered by upstream feed","kind":"FROZEN","remove":[[3,4]],"add":[[4,5]]}
$ node bin/cli.js patch patch1.json
{
  "id": "cert-0002",
  "seq": 2,
  "prevHash": "1c06a3013a65f7673ee6cecb0df39f78e128476fcf53c30096d16041b3c57f8e",
  "type": "patch",
  "inputDigest": "1a01ee480d64ded8b2cc4db3d5370664d0dff2611d4ca767643b05dada6e0645",
  "ops": [
    { "op": "patch", "kind": "FROZEN", "removed": [{ "start": 3, "end": 4 }], "added": [{ "start": 4, "end": 5 }] }
  ],
  "stateHash": "4f2064b132e57fd180088f6fbf50401ba8655eea170801eba19ad5ad1a3101a2",
  "supersedes": "cert-0001",
  "invalidationReason": "correction: freeze window mis-registered by upstream feed",
  "patchId": "p1",
  "hash": "1b39662e18fe7cd0f446156d6d3aae21e7fb30b1f03290097542c51048fae52f"
}
$ node bin/cli.js verify
{ "ok": true, "certs": 2, "stateHash": "4f2064b132e57fd180088f6fbf50401ba8655eea170801eba19ad5ad1a3101a2" }
```

撤销补丁（空洞恢复）与错误输出：

```
$ node bin/cli.js revert p1        # 产生 type=revert 的 cert-0003，FROZEN 恢复为 [3,4)
$ node bin/cli.js import bad.json  # bad.json 含区间 [9,9)
{"error":"E_INTERVAL","message":"invalid interval [9, 9): start must be < end"}
exit=1
```

## 库用法

```js
import { AuditService } from './src/service.js';

const svc = new AuditService();
svc.importBatch([{ op: 'add', kind: 'VALID', intervals: [{ start: 0, end: 5 }] }]);
svc.queryPoint(3);                 // { point: 3, kinds: ['VALID'], status: 'VALID' }
svc.report(0, 10);                 // { domain, gaps, overlaps, pending }
svc.applyPatch({ reason: 'fix', kind: 'VALID', remove: [{ start: 1, end: 2 }] });
svc.revertPatch('patch-1');
svc.verify();                      // 重放整条证书链，篡改即抛 E_CERT
```
