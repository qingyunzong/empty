# regreport — 监管报表授权证明与可重算汇总

Node.js 22,仅标准库,离线单机。财务共享中心生成监管报表前,证明汇总单元未越权且可重算。

## 机制

- 数据单元有密级(`levels` 有序数组,`unit.level`);角色有 `clearance`,经 DAG `inherits` 继承。
- 授权判定:显式 `deny` 优先于一切 → 显式 `allow` → 闭包内最大 clearance ≥ 单元密级。
- 汇总单元可见 ⟺ 来源闭包(递归展开嵌套汇总后的叶子)中每个来源可读,或被**版本匹配**的显式脱敏规则(`id/unit/field/version/roles` 五元组)覆盖。
- 脱敏字段不参与汇总求和;撤销脱敏不追溯已签发报表(报表内嵌快照,verify 自包含)。
- 证明含:来源闭包 `sourceClosure`、规则路径 `rulePath`(含继承链)、脱敏/授权/角色/来源数据快照、canonical 哈希(键排序 JSON 的 SHA-256)。
- 验证失败给出最小越权集合 `minimalSet`(每个元素都独立缺失授权)。

## 用法

```sh
node cli.js build spec.json report.json   # 签发:spec.request = {unit, role}
node cli.js verify report.json            # 验证:哈希 + 快照重估授权 + 重算字段
node --test                               # 运行测试
```

错误一律写 stderr,退出码 1。错误码:`E_AUTH`(越权)、`E_MASK`(脱敏版本不匹配)、
`E_HASH`(篡改)、`E_RECOMPUTE`(不可重算)、`E_CYCLE`(继承/来源环)、
`E_PARSE`(JSON/格式)、`E_SPEC`(规约非法)、`E_IO`(文件读写)。

## spec.json 模式

见 `examples/spec.json`。顶层:`levels`、`roles`、`units`(数据单元含 `level/version/fields`;
汇总单元 `aggregate: true, sources: [...]`)、`grants`(`{role, unit, effect: allow|deny}`)、
`masks`(`{id, unit, field, version, roles}`)、`request`(`{unit, role}`)。
