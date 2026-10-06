# 差旅报价 CLI

组合车票覆盖固定出行日的最优报价工具,Go 实现,`go test ./...` 可运行全部测试。

## 构建与测试

```sh
go build -o travelcli .
go test ./...
```

## 子命令

### cover — 覆盖问题

组合单程票 / 区间票 / 通票(统一建模为"覆盖给定日集合")覆盖固定出行日。
票种 ≤ 22,每票限购一次。目标序:**费用最小 → 票数最少 → ID 序列字典序最小**。

```sh
travelcli cover -days 1,2,5 -tickets tickets.json [-verify] [-json]
# tickets.json: [{"id":"P","kind":"通票","price":80,"days":[1,2,5]}]
```

输出覆盖证书(总费用、购票列表、逐日覆盖关系)。`-verify` 穷举全部 2^n 个
购票子集核验最优性。求解器为分支定界(后缀并集 + 当前最优剪枝),证书可由
`VerifyCover` 独立校验。

### activate — 购票与激活联合规划

车票首次乘车触发激活,激活后 `validDays` 天有效,有效期内最多使用
`maxUses` 天(覆盖上限),每票限购一次。求购票集合与激活时刻的联合最优方案,
目标序同上。

```sh
travelcli activate -days 1,3,7 -tickets tickets.json [-verify] [-json]
# tickets.json: [{"id":"A","price":100,"validDays":3,"maxUses":2}]
```

输出逐日使用证书(每天用哪张票、每张票哪天激活)。求解器为记忆化搜索,状态为
(天数下标, 已购票集合, 已激活车票的(有效期至, 剩余次数))。`-verify` 对短行程
穷举全部购票子集 × 逐日分配方案(分配隐含激活时刻)核验最优性,规模过大时拒绝。

## 参数

- `-days` 出行日列表,支持逗号与区间,如 `1-3,7`
- `-tickets` 车票 JSON 文件路径,`-` 表示标准输入
- `-verify` 穷举核验最优解
- `-json` 以 JSON 输出证书
