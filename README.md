# settle-replay

卡组织季度返还结算：重放费用事件流（charge / correct / snapshot），产出可审计的
每周期应返额、调整链、快照与 supplement 批次。Node.js 22，仅标准库。

## 用法

```sh
node cli.js events.jsonl settle.json   # 成功退出码 0；E_LINK/E_SNAPSHOT 等错误退出码 1
node --test                            # 运行全部测试
```

## 事件模型（JSONL，每行一个事件）

- `rule`：`{type,id,scope:"product"|"merchant",productId?|merchantId?,period?,tiers:[{upTo,rateBps}]}`
  - `tiers` 按交易量（分，整数）升序，`upTo` 为含边界上限，最后一档 `upTo:null`；`rateBps` 为基点费率。
  - 应返额 = `floor(volume * rateBps / 10000)`，整体量适用所达档位费率（非边际累进）。
- `charge`：`{type,id,merchantId,productId,period,amount}`，amount 为非负整数分。
- `correct`：`{type,id,linksTo,amount}`，不删除原事件，以反向调整链接原 charge id，
  将原 charge 的有效金额替换为 `amount`；可多次更正形成调整链。
- `snapshot`：`{type,id,merchantId,period}`，月末快照，冻结该商户该周期结算并记录 sha256 哈希。

## 规则解析

1. 商户级规则覆盖产品级规则（产品规则为继承的默认）。
2. 同一 scope+key 内“覆盖取最近定义”：事件流中后定义的规则生效。
3. 同一商户同周期并列候选（如多个产品各有产品级规则）按费率升序、再按 ruleId 升序取首个。
   比较费率取规则首档 `rateBps`。
4. 规则可带 `period` 限定生效周期；快照时刻只用快照前已定义的规则。

## 快照与 supplement

- 同一商户同周期重复 snapshot → `E_SNAPSHOT`（退出码 1）。
- 快照后仍允许 charge/correct：不改动原快照（哈希不变），全部计入期末生成的
  supplement 批次（`SUPP-<snapshotId>`），含 `deltaVolume`/`deltaRebate`。
- `correct.linksTo` 未指向已出现的 charge → `E_LINK`（退出码 1）。

## 输出（settle.json）

`periods[]` 按 merchantId、period 排序，每项含：
`volume`/`ruleId`/`rateBps`（期末当前值）、`rebate`（应返额：已快照则取快照值）、
`currentRebate`（期末重算值）、`totalRebate`（应返额+supplement 差额）、
`adjustments`（调整链）、`snapshot`（含哈希）、`supplements`（批次列表）。
输出无时间戳，完全由输入事件决定，可重放审计。
