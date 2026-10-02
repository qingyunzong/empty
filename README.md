# settlement-explorer

离线结算状态探索库与 CLI（Node.js 22 标准库，无外部依赖）。对多笔两阶段
转账（reserve / commit / cancel）与账户 freeze，枚举所有保留每个参与者
程序顺序的交错步骤，验证每一步的安全不变量，并输出可复现证书或最小反例。

## 语义

- 状态：`balances`（余额）、`frozen`（冻结额）、`holds`（待清算持有）、`frozenAccounts`。
- `reserve`：冻结转出方额度并登记持有；账户被 freeze 后拒绝新增 reserve。
- `commit`：过账（转出方余额减少、接收方增加）并释放持有。
- `cancel`：仅在 commit 前有效，恢复冻结额；commit 后被业务拒绝。
- 业务被拒步骤只追加 `rejected` 记录，不改账。
- 不变量：总额守恒；每个账户持有（冻结额）不得超过其余额；冻结额非负。

## 用法

```sh
node src/cli.js explore plan.json
```

输出 JSON：`reachable`（可达配置数）、`violating`（违反不变量的配置数），
以及 `counterexample`（按步骤序列字典序最小的反例，含最终状态哈希）或
`certificate`（安全证书，含全部状态哈希 `statesHash` 与最终状态哈希
`finalStatesHash`）。非法计划（未知 id、重复 id、负金额、同笔先 cancel 后
commit、重复撤单等）以退出码 1 拒绝，stdout 输出 `{"error":"INVALID_PLAN"}`。

## plan.json 格式

```json
{
  "accounts": { "A": 100, "B": 0 },
  "freeze": ["B"],
  "actors": {
    "alice": [
      { "type": "reserve", "id": "t1", "from": "A", "to": "B", "amount": 50 },
      { "type": "commit", "id": "t1" }
    ],
    "bob": [{ "type": "freeze", "account": "A" }]
  }
}
```

- `accounts`：账户初始余额（非负）。
- `freeze`（可选）：初始即冻结的账户。
- `actors`：每个参与者的有序步骤数组；步骤标签为 `<actor>#<index>`。

## 测试

```sh
node --test
```

测试含 ≤4 步计划与独立枚举器（`test-utils/crosscheck.js`）的全序列对照。
