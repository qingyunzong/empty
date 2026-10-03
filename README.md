# limitd — 预留限额 DSL 与并发历史线性化判定

交易前置对同一账户的下单限额做预留（reserve/confirm/release）。多个策略并发提交时，
本工具判定一条观测到的并发历史是否可能线性化，并输出全部合法的串行化顺序作为证据/反例。
纯 Node.js 22 标准库实现，无第三方依赖。

## 用法

```sh
node bin/limit.js check spec.lim history.json --max 8
# 或通过 package.json 的 bin 链接: limit check spec.lim history.json --max 8
node --test   # 运行测试
```

- `spec.lim`：限额规格（账户容量、策略子限额、容量约束不变式、订单）。
- `history.json`：观测到的并发历史（`{"history": [...]}` 或直接数组）。省略时使用
  spec 内嵌的 `history { ... }` 块。
- `--max N`：历史规模上限（默认 8），超过即返回 `E_BOUND` 而不是误判。
- `--strict-pending`：历史中含 PENDING 操作时以 `E_PENDING` 失败退出（默认仅告警）。

## DSL

```lim
account acct {
  capacity 10;                        # 账户级限额（常量表达式）
  strategy alpha { limit 6; }         # 策略级子限额，总和不得超过账户容量
  strategy beta  { limit 4; }
  invariant alpha.used + beta.used <= capacity;   # 容量约束表达式
}

order o1 { account acct; strategy alpha; amount 6; }

history {                             # 可选的内嵌历史（逻辑时钟）
  op A = reserve o1 invoke 1 response 4 ok;
  op B = reserve o2 invoke 2 response 3 fail;
  op C = release o1 invoke 5 pending; # 未知 response 记为 PENDING
}
```

- 词法：`account/order/reserve/confirm/release`、逻辑时钟相关
  `invoke/response/pending/ok/fail`、数字、标识符、注释（`#`、`//`）。
- 容量约束表达式由 **Pratt 解析器**（precedence climbing）解析：
  `|| && == != < <= > >= + - * / %`、一元 `! -`、括号、点路径引用
  （`capacity`、`used`、`<strategy>.used`、`<strategy>.limit`）。
- 表达式编译为栈机**字节码**（`PUSH/LOAD/NEG/NOT/BIN`），由 VM 求值。

## 静态类型保证（E_TYPE）

- 策略子限额之和不得超过账户容量；
- `capacity/limit/amount` 必须是常量表达式，不变式只能引用已声明的名字；
- `confirm` 只能消费存在对应 `reserve` 的订单；
- `release` 必须有对应 `reserve` 且**不得重复**；
- 历史中的操作必须引用已声明订单；`response >= invoke`（逻辑时钟合法）。

## 线性化判定

每个操作是逻辑时钟上的 `[invoke, response]` 区间；response 未知记为 **PENDING**
（绝不当作失败）。实时序：已完成的 i 若 `response(i) <= invoke(j)` 则 i 必须先于 j。

VM **不做真并发**：枚举全部有限交错——对每个 PENDING 子集（视为成功或排除），
回溯枚举实时序的所有线性扩展，逐个串行重放并按记录的结果剪枝。历史可线性化
当且仅当存在某个交错同时满足限额语义与实时序。所有合法顺序按**字典序**全部输出；
无法找到任何合法顺序时返回 `E_LINEAR`（反例即“不存在这样的顺序”）。

规模保护：`n > --max` 或最坏枚举量 `n! * 2^pending` 超过工作上限（默认 5,000,000）
时返回 `E_BOUND`，绝不给出猜测性结论。

## 操作语义（串行重放）

- `reserve(o)`：订单未预留过，且账户/策略用量加 amount 后不超过 capacity/limit，
  且全部不变式成立 → ok，占用额度；否则 fail。
- `confirm(o)`：仅当订单处于 reserved → 确认（继续占用额度）。
- `release(o)`：仅当订单处于 reserved → 释放额度。重复 release 静态拒绝。

## 错误码与退出码

| 代码       | 退出码 | 含义                                   |
|------------|--------|----------------------------------------|
| E_LINEAR   | 1      | 历史不可线性化（无任何合法交错）       |
| E_TYPE     | 2      | 规格或历史未通过静态类型检查           |
| E_BOUND    | 3      | 超过规模/枚举上限，拒绝误判            |
| E_PENDING  | 4      | 含 PENDING 操作（默认告警；`--strict-pending` 时报错） |
