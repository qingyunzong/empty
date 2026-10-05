# auction — 分段需求拍卖库

纯 Go 标准库实现, 无第三方依赖。

## 规则

- 订单由若干价格段组成, 每段含独立价格与数量; 全库设总数量上限。
- 分配按价格从高到低逐段进行; 同一价格需求超过剩余额度时按比例分配。
- 比例分配的整数余数按小数余数从大到小补齐; 余数相同按订单 ID 小者优先。
- 成交价为最后一个获得分配的段的价格; 无任何成交时返回空结果(`Result{}`)。
- 撤单(`Cancel`)后 `Clear` 基于当前订单集合重新计算; 各段分配相互独立。

## API

- `New(capacity int64) *Auction` — 创建带数量上限的拍卖库。
- `Submit(Order) error` — 登记订单(校验段合法性、ID 唯一)。
- `Cancel(id int64) error` — 撤单。
- `Clear() Result` — 清算, 返回成交价与各段分配。

## 测试结果

`go test ./...` 实际运行结果(2026-10-05, go1.27.1 linux/amd64):

```
=== RUN   TestPricePriority
--- PASS: TestPricePriority (0.00s)
=== RUN   TestProRataAt_samePrice ... (略, 共 10 个测试全部 PASS)
PASS
ok  	auction	0.007s
```

覆盖: 价高优先、同价比例分配、余件按余数大再 ID 小、成交价为
最后分配段价格、无成交返回空、撤单重算、分段独立分配、数量守恒
(200 组随机用例校验 `成交总量 == min(上限, 总需求)` 且每段不超需求)、输入校验。
