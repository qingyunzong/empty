# audit-interval-bound

内审费用流水抽样的精确区间传播库与 CLI。纯 Node.js 22 标准库，无外部依赖。

## 机制

- 每项误差 `err = actual - claimed` 为 BigInt 有理数，区间
  `[min(0, err), max(0, err)]` 按符号拆分为负部和与正部和。
- 总体区间对已审计层做精确加法传播；`bound` 以 `1/confidence` 保守外推
  （confidence ∈ (0,1]，取 1 时即精确和）。
- 未审计层绝不并入区间：存在未审计项时 `bound` 返回
  `status: "pending"` 且 `code: "E_PENDING"`，witnessIds 只含已审计项。
- 每次变更（addItem/audit/correct）追加 SHA-256 哈希链证书并递增版本；
  `explain()` 输出当前证书，`verify(cert)` 可检测过期解释。

## 错误码

- `E_LAYER`：已审计层为空（bound/explain 无可传播数据）。
- `E_CONF`：confidence 不在 (0,1]。
- `E_PENDING`：存在未审计项（随 bound 结果返回，非抛出）。
- `E_ITEM` / `E_RATIONAL` / `E_CMD` / `E_PARSE`：输入类错误。

## CLI

JSON Lines，stdin 每行一条命令，stdout 每行一个结果：

```sh
printf '%s\n' \
  '{"cmd":"addItem","id":"a","claimedNum":100,"claimedDen":1}' \
  '{"cmd":"audit","id":"a","actualNum":90,"actualDen":1}' \
  '{"cmd":"bound","confidenceNum":1,"confidenceDen":1}' \
  '{"cmd":"explain"}' | node src/cli.js
```

`correct` 的 `newClaimed` 接受 `"num/den"` 字符串、整数或 `{"num":..,"den":..}`。

## 测试

```sh
node --test
```
