# RESULTS

运行环境：Node.js v22.22.1，仅标准库，单机离线。
运行时间：2026-10-04（Asia/Shanghai）。

## `node --test` 全量结果（真实输出）

```
ok 1 - test/acceptance.test.js
ok 2 - test/checker.test.js
ok 3 - test/cli.test.js
ok 4 - test/lexer.test.js
ok 5 - test/parser.test.js
ok 6 - test/vm.test.js
# tests 6
# pass 6
# fail 0
```

逐文件统计（共 35 个断言级测试，全部通过）：

| 文件 | 通过 |
| --- | --- |
| test/acceptance.test.js | 4 |
| test/checker.test.js | 5 |
| test/cli.test.js | 4 |
| test/lexer.test.js | 6 |
| test/parser.test.js | 5 |
| test/vm.test.js | 11 |
| 合计 | 35 / 35 |

## 验收项核对

1. **HALF_EVEN 边界 0.005 / 0.015** — `test/acceptance.test.js` 验收 1：
   `10.00 * 5bps = 0.005 → 0.00`（偶），`30.00 * 5bps = 0.015 → 0.02`（奇进位），
   `50.00 * 5bps = 0.025 → 0.02`；trace 中 `ROUND` 步骤记录 `in/rem/out`。
2. **三档并列最低全部输出** — 验收 2：三档并列命中同一订单，
   `ties = ["arm0","arm1","else"]` 全部列出，费用取最低；另测并列不同价时
   仅最低档列入 ties。
3. **总费用 ≠ 分项和 → E_CONSERVE** — 验收 3：`conserve total == ta + channel`
   （25.00 ≠ 30.00）触发 `E_CONSERVE`；另测分账比例 >100% 时尾差为负同样触发。
4. **随机 500 单对照 + 证书重放** — 验收 4：固定种子生成 500 单
   （申购/赎回、档位边界、最低费、参数覆盖），与测试内独立 BigInt 参考实现
   逐单比对费用、分项、尾差全部一致；`buildCert` 后 `verifyCertificate` 通过；
   篡改舍入步骤 → `E_ROUND`，篡改分账 → `E_CONSERVE`，换订单 → `E_CERT`。

## CLI 冒烟（真实输出）

```
$ node bin/fee.js calc examples/contract.fee examples/orders.json --cert
certificate written to examples/orders.cert.json
# o1=120.00  o2=5.00(最低费)  o3=25000.00  o4=6.15  o5=1.00(最低费)

$ node bin/fee.js verify examples/contract.fee examples/orders.json examples/orders.cert.json
OK
```

备注：CLI 测试通过 `src/cli.js` 的 `runCli(argv)` 进程内调用完成
（`bin/fee.js` 为其薄封装），因沙箱环境禁止 spawn 子进程。
