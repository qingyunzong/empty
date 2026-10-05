# RESULTS — 真实运行记录

- 环境：Node.js v22.22.1，仅标准库，单机离线（无网络、无第三方依赖）
- 记录时间：2026-10-05 16:09 CST（2026-10-05T08:09:06Z）
- 命令：`node --test`

## 测试总览（真实输出）

```
ok 1 - test/a_balanced.test.js
ok 2 - test/b_remove_extra.test.js
ok 3 - test/c_relink.test.js
ok 4 - test/cli.test.js
ok 5 - test/d_enumeration.test.js
ok 6 - test/e_search_bound.test.js
ok 7 - test/helpers.js
ok 8 - test/oracle.js
ok 9 - test/validation.test.js
# tests 9
# pass 9
# fail 0
# duration_ms 22170.472204
```

9 个测试文件、31 个子测试全部通过，0 失败，总耗时约 22.2 秒。

| 文件 | 子测试数 | 耗时 |
| --- | --- | --- |
| test/a_balanced.test.js | 5 | 365 ms |
| test/b_remove_extra.test.js | 3 | 372 ms |
| test/c_relink.test.js | 2 | 343 ms |
| test/cli.test.js | 5 | 370 ms |
| test/d_enumeration.test.js | 4 | 22117 ms |
| test/e_search_bound.test.js | 4 | 372 ms |
| test/validation.test.js | 8 | 400 ms |

## 验收点对照

- **A 完全平衡**：相同/跨账户重排（保持同账户因果）/不同 id 同规范形的账本均判 `balanced: true`；乘积自动机找到接受运行；非零总额判不平衡。
- **B 单边多账 → removeExtra**：左侧多 1 事件 → `minCost 1` 且脚本含 `removeExtra(left)`；多 1 个平衡对 → `minCost 2`，存在全 `removeExtra` 脚本；右侧盈余镜像为 `removeExtra(right)`。
- **C 关联号错配 → relink**：错配事件给出单条 `relink` 脚本（`minCost 1`），且严格优于 remove+add（代价 1 < 2）。
- **D 小账本枚举对照**（≤8 事件、2 账户、2 币种，真实计数）：

```json
{"pairs":3258,"balanced":22,"unbalanced":3222,"searchBound":14,
 "minCostVerified":3221,"minCostSkipped":1,"scriptsVerified":6830,
 "certsVerified":3236,"productChecked":160,"d1":801,"d2":2257,"d3":200}
```

  - D1：|L|+|R|≤2、16 种规范形（2 账户 × 2 方向 × 2 关联号 × 2 金额，覆盖 USD/EUR）全枚举 801 对；
  - D2：|L|+|R|≤3、8 种规范形全枚举 2257 对；
  - D3：≤8 事件随机变异对 200 组（确定性种子 20261005）；
  - 每对校验：`balanced` 判定与定义一致；3221 对的最小代价与独立暴力 oracle（全操作字母表 BFS，未共享剪枝逻辑）完全一致（1 对因 oracle 状态上限跳过，未作为无差异处理）；6830 条输出脚本逐条应用后均达联合平衡；3236 张证书全部通过 `verifyCertificate`；160 对抽查乘积自动机 BFS 与快速判定一致。
- **E 超过界 K=5**：左侧多 6 事件（3 个盈余平衡对），`--k 5` → `error.code = SEARCH_BOUND`，`balanced` 保持 `false`（受限搜索绝不报无差异），证书 `provenLowerBound = 6 > k = 5` 且通过验证；同一对账本 `--k 6` 时解出 6 条 `removeExtra` 的最优脚本；预算=1 的强制受限搜索同样报 `SEARCH_BOUND`（下界 ≥ 2）。

## CLI 实跑（`node cli.js diff examples/<X>-left.jsonl examples/<X>-right.jsonl --k 5`）

| 用例 | 退出码 | balanced | minCost | scriptCount | 首条脚本 | error |
| --- | --- | --- | --- | --- | --- | --- |
| A 完全平衡 | 0 | true | 0 | 0 | — | — |
| B 单边多账 | 1 | false | 2 | 2 | `removeExtra left lx1` + `removeExtra left lx2` | — |
| C 关联号错配 | 1 | false | 1 | 1 | `relink left l2: t9 → t1` | — |
| E 超过 K=5 | 2 | false | — | 0 | — | `SEARCH_BOUND`（已证下界 6） |

证书验证回路：`node cli.js verify examples/E-left.jsonl examples/E-right.jsonl e-cert.json` 输出 `{"valid": true}`，退出码 0；篡改证书（改 `provenLowerBound`、截断前缀、伪造 continuation）均报 `CERT_INVALID`，退出码 2。

## 备注

- 沙箱环境会吞没嵌套 node 子进程的异步 stdout，因此 CLI 测试通过 `cli.js` 导出的 `run(argv, {write})` 在进程内驱动（参数解析、退出码、JSON 输出路径与真实 CLI 完全一致）；真实 CLI 已在 shell 下逐用例实测（见上表退出码）。
- 规模限制：每本账 200 事件（`INPUT_TOO_LARGE`）；并列最优脚本输出上限 20 条，`scriptCount` 保留完整计数（如 5 个独立盈余对产生 32 条并列最优，输出前 20 条）。
