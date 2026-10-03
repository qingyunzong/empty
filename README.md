# qa-lot-cert — 食品工厂批次放行离线判定与可验证证书

Node.js 22、仅标准库、单机离线。检验员录入缺陷（tests.jsonl），QA 配置放行策略（policy.json），系统输出可审计复查的证书（cert.jsonl）。

## 用法

```sh
node cli.js evaluate --lots lots.json --tests tests.jsonl --policy policy.json --cert cert.jsonl
node cli.js verify   --lots lots.json --tests tests.jsonl --policy policy.json --cert cert.jsonl
node --test   # 运行全部测试
```

## 输入格式

- `lots.json`: `{ "lots": [{ "lotId": "L001", "productFamily": "ready-meal" }] }`
- `tests.jsonl`: 每行一个事件
  - 检验: `{"type":"test","testId":"T1","lotId":"L001","defect":"label-misprint","severity":2}`
  - 撤销: `{"type":"revoke","testId":"T1"}`（QA 撤销单次检验）
- `policy.json`: `{ "families": {"ready-meal": 1}, "versions": [{"version": 1, "rules": [{"id":"R1","severity":1,"action":"release"}]}] }`
  - 版本号必须从 1 连续递增，否则 exit 12；`action` ∈ `release|hold|recall`。

## 判定规则

1. 批次继承产品族风险等级；缺陷严重度更高时覆盖继承值（effective = max）。
2. 同严重度下 recall 策略永远优先；release/hold 冲突按更晚生效（更高 version）的策略；同版本冲突 fail-safe 为 hold；无适用规则默认 hold。
3. 撤销检验后重算：旧证书状态置为 `needs-recompute` 并保留（不可删除），追加新证书；输入未变时重算幂等，不追加。
4. 放行证书若存在微小扰动（单缺陷严重度 ±1 或移除单条检验）可翻转结论，证书携带 `counterexample` 字段。

## 证书字段（cert.jsonl 每行）

`certId`、`lotId`、`conclusion`(release|hold|recall)、`status`(valid|needs-recompute)、`ruleChain`（规则链）、`inputHash`（规范化输入的 SHA-256）、可选 `counterexample`、`selfHash`（防篡改自校验哈希）。

## 退出码

| code | 含义 |
|------|------|
| 10 | 哈希不匹配（证书被篡改或输入与认证输入不符） |
| 11 | 缺检验（批次无检验记录 / 撤销引用未知检验） |
| 12 | 策略版本空洞 |

## 结构

- `src/lib.js` — 核心库（判定、反例、证书、评估、验证）
- `cli.js` — 命令行入口（`run(argv, io)` 可进程内复用）
- `test/` — node:test 测试（验收 A–D + 退出码）
- `testkit/helpers.js` — 测试夹具
- `examples/` — 示例数据与已生成证书
- `RESULT.md` — 真实测试运行记录
