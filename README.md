# 卡组织季度返还结算（费用事件重放）

离线单机、Node.js 22、仅标准库。重放 `events.jsonl` 中的费用事件，产出可审计的周期
结算结果 `settle.json`：每周期应返额、调整链、快照与 supplement 批次。

## 事件模型

每行一个 JSON 事件：

- `rule`：阶梯规则。`{type:"rule", ruleId, scope:"product"|"merchant", productId|merchantId, ts?, tiers:[{min, bps}]}`
  - `min` 为交易量下限（含），`bps` 为基点费率；金额一律为整数（分）。
  - 商户级规则覆盖产品级（继承自产品到商户）；同级取最近定义（`ts`，缺省按事件序号）；
    并列按费率升序、再按 `ruleId` 升序。
- `charge`：`{type:"charge", id, merchantId, productId, period, amount}`
- `correct`：`{type:"correct", id, linksTo}` 反向调整，不删除原事件，链接原 charge id；
  同一 charge 只能被冲正一次。
- `snapshot`：`{type:"snapshot", id, merchantId, period, hash?}` 月末快照，冻结当时结算
  并计算 sha256 哈希；可选 `hash` 字段用于校验，不匹配报 `E_SNAPSHOT`。

快照之后仍允许更正/迟来交易，但只生成 supplement 批次（`<snapshotId>-sup-1`），
原快照记录与哈希不变。

## 输出

`settle.json` 的 `periods[]`：已快照周期给出冻结的 `volume/rebate/ruleId/tier`、
`snapshot`（含哈希）、`supplements`（含 delta）；未快照周期给出最终实时结算。
`adjustments` 为调整链（chargeId -> corrections）。

## 用法

```sh
node cli.js events.jsonl settle.json
node --test
```

错误码：`E_LINK`（悬空/重复冲正链接）、`E_SNAPSHOT`（重复快照/哈希不匹配）、
`E_PARSE`（输入非法），均退出码 1；参数缺失退出码 2。
