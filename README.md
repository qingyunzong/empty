# recon

三方对账：银行流水 `bank.jsonl`、内部账 `core.jsonl`、人工调整 `adj.jsonl`，产出可入账分录与冲突。Node.js 22，仅标准库。

## 用法

```
recon <bank.jsonl> <core.jsonl> <adj.jsonl> --out entries.jsonl --conflicts conflicts.json [--tol N]
```

- 每行一个 JSON 对象，字段：`explicitId?`、`valueDate`、`account`、`ccy`、`amount`；`adj` 另支持 `link: {bank: <ref>, core: <ref>}`，`ref` 为 explicitId 字符串或 `{valueDate,account,ccy,amount}` 键对象。
- 分组键：`explicitId` 优先，否则 `(valueDate, account, ccy)`。explicitId 组按 id 直接配对；键组内按金额多重集做最大二分匹配（Kuhn），`|bank-core| <= tol` 可配对，差值记入 `rounding`；候选并列时按 (金额差, valueDate, explicitId, seq) 字典序取。
- `entries.jsonl` 仅含确定项：bank↔core 配对成功且关联 adj 全部在容差内。
- `conflicts.json` 规则：`MISSING_CORE`（bank 有 core 无）、`UNSETTLED`（core 有 bank 无）、`ADJ_CONFLICT`（adj 与任一侧金额超差）、`THREE_WAY`（同 explicitId 三方金额两两超差）。每条含三方规范哈希 `hash`（sha256，键序无关的稳定序列化）。

## 退出码

- `0` 成功；`1` 数据格式错误；`2` 参数错误
- `18` 重复 explicitId（同一文件内）
- `19` 负容差（或非法 `--tol`）
- `20` adj link 悬空（引用的 bank/core 键不存在）

## 测试

```
node --test
```

含 n≤7 独立笛卡尔枚举校验：对随机小规模用例暴力枚举全部匹配，验证库内匹配数最大且结果确定。
