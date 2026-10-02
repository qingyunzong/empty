# report-proof

财务共享中心监管报表的授权证明与可重算验证（Node.js 22，仅标准库）。

## 用法

```
node cli.js build spec.json report.json   # 签发报表（含授权证明）
node cli.js verify report.json            # 重算并验证证明
node --test                               # 运行测试
```

错误输出到 stderr，退出码 1。错误码：`E_INPUT`（输入非法/环）、`E_DENY`（越权，附最小越权集合）、`E_MASK`（脱敏规则缺失/撤销/版本不匹配）、`E_PROOF`/`E_HASH`（证明或哈希不一致）。

## 机制

- 角色经 DAG 继承（`roles.<role>.parents`），密级有序：`public < internal < confidential < secret`。
- 读权限判定：任一祖先角色的 `deny` 优先；否则显式 `allow` 或角色 clearance ≥ 单元 level 可读；默认拒绝。
- 汇总单元可见 ⟺ 来源闭包中每个单元可读，或被请求中引用的有效脱敏规则（字段+版本，未撤销）覆盖。
- 证明含来源闭包、规则路径（继承链/脱敏规则）、canonical 哈希（键排序 JSON 的 SHA-256）。
- 报表内嵌签发时 spec 快照：撤销脱敏不追溯，旧报表 verify 仍通过；新签发按当前 spec 判定。
- verify 从快照重算闭包、授权与输出，比对 canonical 哈希；失败给出最小越权集合。

## spec.json 格式

见 `examples/spec.json`。关键字段：`roles`（parents/clearance）、`grants`（role/unit/effect）、`units`（level/data 或 sources）、`masks`（id/unit/field/version/revoked）、`request`（role/unit/masks 引用）。
