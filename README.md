# audit-revoke-log

Append-only 审计日志库与 CLI：支持撤销标记、按时间点回滚视图与状态哈希。Node.js 22，仅标准库。

## 模型

- 日志条目不可变；`revoke` 是新增条目，通过 `targetId` 指向目标。
- 条目携带严格递增的整数时间 `t`；`asOf(t)` 视图隐藏 `t` 之后的所有条目。
- 撤销级联：撤销一个 revoke 条目会使其失效，被它隐藏的目标恢复可见；
  更长的撤销链按撤销时间先后逐层级联（奇偶效应）。
- 同一目标被多个 revoke 指向时，任一"有效"（自身未被撤销）的 revoke 都会隐藏目标。
- 撤销环（含自撤销）在写入时拒绝，报 `E_REVOKE_CYCLE`。
- 状态哈希 = 仅可见条目 canonical 化（键排序的稳定 JSON）后的 SHA-256，
  隐藏条目不影响哈希。

## 输入格式（JSONL，每行一条命令）

```json
{"op":"append","id":"a1","t":1,"data":{"note":"..."}}
{"op":"revoke","id":"r1","t":2,"targetId":"a1"}
{"op":"asOf","t":2}
```

`asOf` 命令会对当前状态输出一个视图；`--as-of <t>` 在处理完整个文件后追加输出一个视图。

## CLI

```sh
node cli.js log.jsonl --as-of 123
```

每个视图输出为一行 JSON：`{"type":"view","asOf":t,"visible":[...],"hidden":[...],"hash":"..."}`。
`hidden` 中 `reason` 为 `after-as-of` 或 `revoked`（含 `by` 指向生效的撤销条目）。
错误写入 stderr 并以退出码 1 结束，错误码包括
`E_ARGS` / `E_IO` / `E_PARSE` / `E_SCHEMA` / `E_UNKNOWN_OP` / `E_DUPLICATE_ID` / `E_ORDER` / `E_REVOKE_CYCLE`。

## 库

```js
const { AuditLog } = require('./auditlog.js');
const log = new AuditLog();
log.addAppend({ id: 'a1', t: 1, data: {} });
log.addRevoke({ id: 'r1', t: 2, targetId: 'a1' });
log.computeView(1); // { asOf, visible, hidden, hash }
```

## 测试

```sh
node --test
```

覆盖验收标准：撤销前后 asOf 视图不同、撤销的撤销恢复可见、撤销环报
`E_REVOKE_CYCLE`、n<=8 随机操作序列对所有 asOf 时刻与独立参考重放实现对照。
