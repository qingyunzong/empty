# RESULTS

- 日期：2026-10-03（Asia/Shanghai）
- 环境：Node.js v22.22.1，仅标准库，离线单机
- 命令：`node --test`

## 测试结果（真实运行输出）

```
ok 1 - tier boundary 999 vs 1000 picks different tiers
ok 2 - post-snapshot correction only enters supplement, snapshot hash unchanged
ok 3 - parallel rules tie-break by rate asc then ruleId; merchant rule overrides
ok 4 - E_LINK on unknown or non-charge linksTo
ok 5 - E_SNAPSHOT on duplicate snapshot for same merchant+period
ok 6 - random streams (n<=200) match naive full recompute
ok 7 - CLI writes settle.json and exits 0
ok 8 - CLI exits 1 on E_LINK and E_SNAPSHOT
# tests 8
# pass 8
# fail 0
```

## 验收对照

1. 跨阶梯边界 999/1000：测试 1，999 落入首档 rateBps=100、1000 落入次档 rateBps=150，应返额分别按档计算。通过。
2. 快照后更正只进 supplement：测试 2，快照后 correct+charge 仅出现在 `SUPP-snap1` 批次；仅用快照前前缀重放得到相同哈希，证明原快照未被修改。通过。
3. 并列规则 tie-break：测试 3，等费率按 ruleId 升序、不等按费率升序；商户级规则覆盖产品级，同级覆盖取最近定义。通过。
4. 随机对照：测试 6，60 个种子、每条事件流 n≤200（charge/correct/rule/snapshot 混合），增量重放 `replay()` 与简单全量重算 `recomputeReference()` 深度相等。通过。

## CLI 验证（真实运行）

- `node cli.js examples/events.jsonl /tmp/settle.json` → 退出码 0，产出含 snapshot 哈希与 supplement 批次的 settle.json。
- E_LINK 输入（linksTo 未知）→ stderr `E_LINK: ...`，退出码 1。
- E_SNAPSHOT 输入（同商户同周期重复快照）→ stderr `E_SNAPSHOT: ...`，退出码 1。
