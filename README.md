# 结算审计日志(append-only + 撤销 + as-of 视图)

仅 Node.js 标准库(Node 22)。日志条目不可变;撤销是追加一条指向 `targetId` 的
`revoke` 条目;`viewAt(t)` 隐藏 `ts > t` 的条目并按撤销时间级联结算撤销效果
(撤销的撤销恢复可见);撤销环报 `E_REVOKE_CYCLE`;状态哈希 = 可见条目 canonical
JSON(键递归排序)的 SHA-256。

## JSONL 命令

```json
{"op":"append","id":"a1","ts":1,"data":{...}}
{"op":"revoke","id":"r1","ts":2,"targetId":"a1"}
{"op":"asOf","ts":2}
```

## CLI

```
node cli.js log.jsonl --as-of 123
```

- 带 `--as-of`:应用全部 append/revoke 后输出该时刻视图(单行 JSON)。
- 不带:遇到文件中的 `asOf` 命令即输出一行视图;若无 `asOf` 命令,输出最终视图。
- 输出:`{"asOf","visible":[...],"hidden":[{"id","reason"}],"hash"}`,
  `reason` 为 `after_as_of` 或 `revoked_by:<id>`。
- 任何错误写 stderr(`E_*: message`)并以退出码 1 结束。

## 库

```js
const { AuditLog } = require('./src/audit');
const log = new AuditLog();
log.apply({ op: 'append', id: 'a', ts: 1, data: 1 });
log.apply({ op: 'revoke', id: 'r', ts: 2, targetId: 'a' });
log.viewAt(1); // { asOf, visible, hidden, hash }
```

## 测试

```
node --test
```

结果见 `RESULTS.md`。
