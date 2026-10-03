# audit-interval-service

审计区间集合服务。Node.js 22、仅标准库、`node:test`、单机离线。

- 登记三类交易区间：`valid`（有效）、`frozen`（冻结）、`exempt`（免审）
- 半开区间 `[start, end)` 上的并 / 交 / 差、规范化、点查询归属、空洞与重叠报告
- 每次批量导入产生防篡改证书：输入摘要 + 操作序列 + 输出区间哈希，链式衔接
- 更正采用反向区间补丁：新证书证明旧证书失效原因与自身覆盖范围；撤销补丁后空洞恢复
- 未知来源区间标记 `PENDING`，参与覆盖计算，不当作不可满足
- 错误码：`E_INTERVAL` / `E_PATCH` / `E_CERT` / `E_UNKNOWN`

## 布局

- `src/intervals.js` — 区间代数：normalize / union / intersect / difference / contains / gaps / overlapReport
- `src/cert.js` — 规范化编码、sha256 摘要、证书签发与链验证
- `src/service.js` — `AuditService`：导入、查询、报告、补丁、撤销、验证
- `src/errors.js` — 四类错误
- `cli.js` — 命令行入口（状态存于 `$AUDIT_STATE`，默认 `.audit-state.json`）
- `test/` — `node --test`

## 区间语义

区间一律为半开 `[start, end)` 且 `start < end`，否则抛 `E_INTERVAL`。
相邻边界不重叠：`[0,5)` 与 `[5,9)` 的交为空、`overlapReport` 不报告；
但二者并集连续，规范化合并为 `[0,9)`。

点查询优先级：`FROZEN > EXEMPT > VALID > PENDING > UNSATISFIED`。

## 证书与补丁

证书主体包含 `inputDigest`（原始输入摘要）、`ops`（操作序列）、
`outputHash`（输出区间哈希）、`prevId`（链指针）与 `cause`（更正/撤销原因），
`id = sha256(canonical(body))`。改动任何一个端点都会使
`digest(output) !== outputHash` 或 `digest(body) !== id`，验证抛 `E_CERT`。

补丁 `{reason, add, subtract}` 作用于 `valid` 集：先减后加。
新证书的 `cause = {type:"correction", invalidates:<旧证书id>, reason, patchId}`
证明旧证书失效原因，`outputHash` 证明新覆盖范围。
`revoke` 仅允许撤销最新补丁，恢复补丁前状态（空洞恢复），
并校验恢复结果与补丁前证书的输出一致，否则抛 `E_PATCH`。

## 测试

```
$ node --test
# tests 2
# pass 2
# fail 0
```

覆盖四条验收标准：

1. `test/intervals.test.js` — `[0,5)` 与 `[5,9)` 不重叠（交为空、重叠报告为空），规范化合并为 `[0,9)`
2. `test/service.test.js` — 补丁填补空洞后撤销，`gaps` 恢复为 `[[5,9]]`
3. `test/service.test.js` — 篡改存储输出的一个端点（`20→21`），`verify()` 抛 `E_CERT`
4. `test/intervals.test.js` — 种子化随机小区间 300 轮，并/交/差与 O(n²) 逐点参考实现对照

## CLI 实录

以下输出均为真实运行结果（`AUDIT_STATE=/tmp/auditdemo/state.json`）。

导入产生证书（截断显示）：

```
$ node cli.js import batch1.json        # {"source":"valid","intervals":[[0,5],[9,20]]}
{
  "cert": {
    "id": "d29dee6f1440da48afdb975fb894933bcfd9df278971f23b1f62851c4150f000",
    "body": {
      "version": 1, "seq": 0, "prevId": null,
      "inputDigest": "2c4ea19032d860acb798db9d124ff56585b8bc9fb5013f4a5060dd66475cbe2f",
      "ops": [{"op":"import","source":"valid","count":2,"intervals":[[0,5],[9,20]]}],
      "outputHash": "8b8775b97c6d2109fe9c6bf61d02d7ceb5052dc653bea23a6eefaf7c6643f906",
      "cause": null
    },
    "output": {"valid":[[0,5],[9,20]],"frozen":[],"exempt":[],"unknown":[]}
  },
  "status": "COMMITTED"
}
```

未知来源标记 PENDING：

```
$ node cli.js import batch3.json        # {"source":"unknown-wire","intervals":[[30,40]]}
  "status": "PENDING"
```

点查询：

```
$ node cli.js query 4      →  {"point":4,"status":"VALID"}
$ node cli.js query 2.5    →  {"point":2.5,"status":"FROZEN"}
$ node cli.js query 35     →  {"point":35,"status":"PENDING"}
$ node cli.js query 99     →  {"point":99,"status":"UNSATISFIED"}
```

空洞报告、补丁填补、撤销恢复：

```
$ node cli.js report 0 20  →  {"gaps":[[5,9]], "valid":[[0,5],[9,20]]}
$ node cli.js patch patch1.json
  {"patchId":"1c3060cb…1465",
   "cause":{"type":"correction","invalidates":"97b8485e…08a9",
            "reason":"late-arriving evidence fills the hole","patchId":"1c3060cb…1465"}}
$ node cli.js report 0 20  →  gaps: []
$ node cli.js revoke 1c3060cb…1465
  {"restored":[[0,5],[9,20]],
   "cause":{"type":"revocation","revokes":"1c3060cb…1465","restores":"97b8485e…08a9"}}
$ node cli.js report 0 20  →  gaps: [[5,9]]
$ node cli.js verify       →  {"ok":true,"certs":5}
```

篡改检测（把存储输出里一个端点 `5` 改成 `6`）：

```
$ node cli.js verify
{"error":"E_CERT","message":"output hash mismatch: intervals were tampered",
 "details":{"certId":"d29dee6f…0f000"}}
exit=1
```
