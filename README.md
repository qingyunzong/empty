# budget-freeze-settlement

预算冻结与批量结算分块选择库及 CLI。Node.js 22,仅标准库,测试使用 `node:test`。

## 模型

- 每个账户有 `budget`(总预算)与 `frozen`(排队支付冻结额);`available = budget - frozen`。
- `enqueue` 将支付按账户预算冻结排队;同一支付 ID 重复 enqueue 为幂等空操作。冻结只影响可用预算:预算可被调低到冻结额以下,`available` 可为负。
- `settle` 选择**可全额结算的最大支付集合**:以各账户当前 `budget` 为容量,最大化入选支付数量;数量并列时选择支付 ID 字典序最小的集合。入选支付结算(预算与冻结同时扣减),落选支付保持排队与冻结。
- `cancel` 仅可撤销排队中的支付,立即释放其冻结;重复撤销幂等。已结算支付不能撤销,只能 `refund`:生成引用原结算块哈希的反向块并恢复预算。
- 选择算法(`lib/selection.js`)是精确搜索,测试中由不超过 12 笔支付的全子集枚举独立对照验证。

## 块格式与链

`blocks/NNNNNN.blk`,首行 `CRC32:<8 hex>`,其余为规范化 JSON 体(键序确定)。块体包含:

- `batch`:批次号;`prevHash`:前块哈希(创世为 64 个 `0`)
- `type`:`settle` | `refund`;`deltas`:入选增量;`rejected`:落选项
- `ref`:仅 refund 块,引用原结算块哈希
- `index`:`{file, next}`,指向自身与下一批文件名,支持增量解码

CRC32 与链哈希(SHA-256)均对块体字节计算。`index.json` 记录已确认批次的 `{batch, hash, file}`。

提交顺序:块体文件 → 索引 → 状态。崩溃恢复:

- 体已写、索引未更新 → 留下孤儿块;`recover` 校验(CRC32、批次序号、prevHash 链接)后承认该批次并补索引,幂等应用其效果。
- CRC 校验失败 → 该批次及后续链上批次保持不可用,已确认前缀(含预算)不变,`recover` 以退出码 1 报告。
- 索引已写、状态未写 → 下次打开时按索引增量解码下一批自动补齐。

## CLI

```
node cli.js [--dir PATH] <command> [args]
  freeze <account> <budget>        创建账户或设置总预算
  enqueue <id> <account> <amount>  排队支付并冻结额度(重复 enqueue 幂等)
  cancel <id>                      撤销排队支付,立即释放冻结
  settle                           选择最大可全额结算集合并提交结算块
  refund <id>                      退款已结算支付(反向块引用原结算哈希)
  batch [n]                        列出已确认块索引,或解码第 n 批
  verify                           校验链完整性(CRC32、哈希、索引)
  recover                          崩溃后承认孤儿块并补索引
```

退出码:`0` 成功;`1` 业务/校验失败(预算不足、非法状态迁移、verify 不一致、recover 遇到坏块);`2` 用法或 I/O 错误。

## 测试

```
node --test > result.txt 2>&1; echo $? >> result.txt
```

覆盖验收点:并列最优枚举对照(≤12 笔全子集)、撤销排队支付与退款已结算支付的预算恢复、坏批次恢复边界(CRC 失败时坏批次及后续批次不可用、已确认前缀预算不变)。
