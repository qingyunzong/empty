# lot-release-certifier

食品工厂质量部离线批次解禁判定工具。Node.js 22，仅标准库，无网络依赖。

## 数据文件

- `lots.json` — `{families: {<族>: {risk}}, lots: [{lotId, productFamily, ...}]}`
- `tests.jsonl` — 检验事件流：`{"type":"test",...}` 与 `{"type":"revoke","testId":...}`
- `policy.json` — `{versions: [...], rules: [{id, severity, action, effectiveFrom, version}]}`
- `cert.jsonl` — 系统输出的证书（追加写，旧证书永不删除）

## 用法

```sh
node cli.js certify [--dir DIR] [--lot ID]   # 签发证书（幂等：输入未变则 up-to-date）
node cli.js revoke --test T-001 [--dir DIR]  # QA 撤销单次检验，相关证书置 stale（需重算）
node cli.js verify [--dir DIR]               # 审计复查：校验签名、输入哈希与结论
```

## 判定规则

1. 批次继承产品族风险等级；缺陷最高严重度覆盖继承值（取 max）。
2. 同严重度多条放行/扣留策略冲突时，生效时间更晚者胜。
3. 召回（recall）策略永远优先，无视生效时间。
4. 放行证书若可被微小扰动（添加/升级一个缺陷）翻转，必须带 `counterexample` 字段。

## 证书字段

`conclusion`、`ruleChain`（继承→覆盖→冲突裁决全链路）、`inputHash`（规范化输入的 SHA-256）、
`counterexample`、`status`（valid/stale）、`certHash`（结论等关键字段签名，status 不在签名内）。

## 退出码

- `10` 哈希/签名不匹配（含伪造证书）
- `11` 缺检验记录或撤销未知检验
- `12` 策略版本空洞

## 测试

```sh
node --test
```

结果见 `RESULT.md`。
