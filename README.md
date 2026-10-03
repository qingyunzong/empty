# netsettle

多边净额结算更正分块库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 模型

- 参与方提交转账（`propose`），系统按批次净额结算（`finalize`）。
- 每个结果块包含：层级号 `level`、父结果哈希 `parent`、CRC32、增量借贷 `deltas`（净支出 = 转出 − 转入）与索引项 `index`；块哈希为规范化 JSON 的 SHA-256。
- 预算：每个参与方的累计净支出上限（`budget`）。未设置视为无上限。
- 结算选择：在保留预算（预算 − 已结算累计净额）内枚举待结算转账的所有子集（≤10 笔全枚举，超出退化为贪心），取可结算笔数最大者；并列时取转账 ID 序列字典序最小者。
- 更正（`correct <level>`）：级联回滚显式依赖该结果的后续批次（其转账回到待结算池），按保留预算重新选择并生成同层级新块；无关批次保持最终态。
- 回滚（`rollback <level>`）：仅回滚该层及后代，转账回到待结算池，不重新结算。

## 持久化与恢复

- 块写入 `blocks/<hash>.json` 后，才原子更新层级索引 `index.json`。
- 崩溃点：块已持久化、索引未更新。恢复时沿块链重算，把可链接的块补入索引；父引用缺失的块保持 `missing`，其转账不进入待结算池、不计入余额。

## CLI

```
node cli.js [--dir DIR] budget <participant> <amount>
node cli.js [--dir DIR] propose <id> <from> <to> <amount>
node cli.js [--dir DIR] finalize
node cli.js [--dir DIR] correct <level>
node cli.js [--dir DIR] rollback <level>
node cli.js [--dir DIR] verify
node cli.js [--dir DIR] state
```

退出码：成功 0；业务冲突（重复转账、无可结算转账、层级非最终等）1；数据损坏（`verify` 报 `CORRUPT`/`MISSING`）2。

## 测试

```
node --test > result.txt 2>&1; echo $? >> result.txt
```
