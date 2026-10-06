# travelcli — 差旅报价优化 CLI

组合单程票、区间票与通票，覆盖固定出行日，求最优购票（及激活）方案。

## 问题定义

- 票最多 **22 种**，每种票**只能买一次**。
- 目标（字典序）：**总费用最小 → 票数最少 → 排序后票 ID 序列最小**。

### 子命令 `cover`：固定日集合覆盖

每张票覆盖一个给定的出行日集合，选择购票子集覆盖全部出行日。
输出覆盖证书（每个出行日由哪张票覆盖），`-verify` 时校验证书并用
穷举（2^n 子集）独立复核最优解。

### 子命令 `activate`：购票与激活联合方案

票在**首次乘车时按乘车顺序触发激活**，激活后 `validity` 天内有效
（含激活日），有效期内最多使用 `cap` 个出行日（覆盖上限）。求解
购买哪些票、每张票哪天激活、每个出行日用哪张票，输出逐日使用证书。
`-verify` 时校验证书，并对短行程穷举**购票子集 × 激活日组合**复核
最优解（规模超限时跳过穷举、仅校验证书）。

票种预设（`kind`）：`single`（validity=1, cap=1）、`interval`、
`pass`（cap 缺省等于 validity）。

## 用法

```sh
go build ./cmd/travelcli

echo '{"days":[1,2,3],"tickets":[{"id":"A","cost":5,"days":[1,2]},
      {"id":"B","cost":5,"days":[2,3]},{"id":"C","cost":9,"days":[1,2,3]}]}' \
  | ./travelcli cover -verify

echo '{"days":[1,2,3],"tickets":[{"id":"S","kind":"single","cost":4},
      {"id":"P","kind":"pass","cost":10,"validity":3}]}' \
  | ./travelcli activate -verify
```

输入为 stdin 或 `-i file` 的 JSON；结果 JSON 写到 stdout 或 `-o file`，
包含 `cost`、`count`、`ticketIds`、证书（`coverage` 或
`purchases`+`daily`）以及 `verified`/`verificationNote`。

## 实现

- `internal/solver/cover.go`：分支限界（按首个未覆盖日展开、贪心种子、
  代价/票数剪枝）+ 全子集穷举核验 + 证书结构校验。
- `internal/solver/activate.go`：按出行日 DFS、以（日索引， 各票到期日/
  剩余次数）为键的记忆化搜索；穷举核验独立枚举购票子集与激活日元组并
  递归判定可行性。两种方案空间等价：激活日即首次乘车日。
- 平局规则在状态间满足单调性（合并固定前缀保持字典序），故可按状态
  保留最优后缀。

## 测试

```sh
go test ./...
```

涵盖手算用例、平局规则、证书篡改拒绝、不可行输入、22 票上限规模，
以及随机小实例上求解器与穷举核验的一致性（`cover` 与 `activate`）。
