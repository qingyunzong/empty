# netsettle

多笔应收应付的净额结算方案优化器。仅依赖 Node.js 22 标准库与 `node:test`，单机离线运行。

## 模型

- 方案 = 净额集 `S ⊆ obligations`：S 内按参与方净额结算，S 外逐笔全额结算。
- 符号约束：任一方在 S 内的净额不得与其全部义务下的最终应收应付符号相反（0 除外）。
- 预算约束（硬约束，同时满足）：总冻结 `freeze ≤ maxFreeze`，单日结算量 `volume ≤ dailyLimit`；任一越界整案不可行，无部分扣款。
- 成本（整数，放大 1e4 倍）：`volume*feeBps + freeze*freezeBps + amountDays*timeBps`，
  其中 `freeze = ceil(volume * (1 + freezeMarginBps/1e4))`，`amountDays` 为金额加权到账天数。
- 并列最优：枚举全部最小成本方案，按固定键序（排序后 id 列表的字典序）选执行方案；
  证书包含完整候选集及其 sha256 哈希，可审计。

## 命令

```sh
node cli.js optimize [--obligations=f] [--constraints=f] [--state=dir]
node cli.js emit       # 输出方案、成本、冻结、证书；原子写入执行标记
node cli.js rollback   # 未执行：撤销方案；已执行：退出码 72，仅生成反向方案
node cli.js explain    # 每个候选的淘汰原因（infeasible / dominated / tied）
```

## 退出码

- `70` 无可行方案（预算不可满足）
- `71` 存在 status=pending 的未决义务，按不可满足处理
- `72` 已执行方案的回滚请求（只允许生成反向方案）

## 测试

```sh
node --test test/*.test.js
```
