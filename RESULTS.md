# RESULTS — 真实运行记录

日期：2026-10-03，环境：Node.js v22.22.1（仅标准库）。

## `node --test`

```
1..10
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7999.542127
```

10 个测试文件全部通过：lexer / parser / typecheck / scope / eval / replay / fuzz / cli
（`test/reference.js`、`test/fuzzgen.js` 为被 node:test 加载的辅助模块，无断言失败）。

## 验收点对应

1. **内层放宽外层阈值无 override 必失败** — `test/scope.test.js`：
   `deny > 12000CNY` 放宽全局 `> 10000CNY` 抛 `E_OVERRIDE`；写 `override` 后编译通过且
   `overrideLog` 留痕（outerRule/outer/inner 俱全）；allow 方向（`< 1000` → `< 2000`）同样受控。
2. **并列最严规则输出稳定排序** — `test/eval.test.js`：同一事件命中 `zg`、`ag`（global）
   与 `c1`（channel）三条 deny，`matched` 恒为 `['ag','zg','c1']`（层级 → 规则名 → 语句序号），
   与源码书写顺序无关。
3. **热更新后旧事件仍按旧版本** — `test/replay.test.js` + CLI：v2（2026-06-01 生效）加载后，
   3 月的事件重放仍是 `version: 1 / allow`，7 月的事件走 `version: 2 / deny`。
4. **随机规则与事件对照独立参考实现** — `test/fuzz.test.js`：300 个种子 × 8 事件，
   字节码 VM 与独立 AST 决策树参考（`test/reference.js`，独立的 CIDR 位串实现）在
   decision / outcome / matched 上完全一致（2400 组对照）；另验证生成器确实覆盖了
   override 留痕路径。

## CLI 实跑

```
$ node bin/risk.js check examples/rules.rsk examples/rules-v2.rsk
OK examples/rules.rsk, examples/rules-v2.rsk (versions: 1, 2)

$ node bin/risk.js eval examples/rules.rsk examples/rules-v2.rsk examples/events.jsonl
{"id":"e1","version":1,"decision":"deny","outcome":"deny","matched":[{"rule":"c_payx","level":"channel","statement":0,"decision":"deny","override":false}]}
{"id":"e2","version":1,"decision":"deny","outcome":"deny","matched":[{"rule":"c_payx","level":"channel","statement":0,"decision":"deny","override":false}]}
{"id":"e3","version":2,"decision":"deny","outcome":"deny","matched":[{"rule":"g_base","level":"global","statement":0,"decision":"deny","override":false}]}
{"id":"e4","version":1,"decision":"review","outcome":"review","matched":[{"rule":"g_base","level":"global","statement":1,"decision":"review","override":false}]}
```

- e1/e2：v1 下渠道规则 `c_payx` deny 命中；内层 `m_vip` 的 allow 无法放行（外层 deny 优先）。
- e3：事件时间在 v2 生效后，按 v2 判定（热更新）；e1/e2/e4 仍回放于 v1。
- e4：`review: "pending"`，未决人工复核不视为通过，outcome 保持 `review`。
- `--explain` 时输出 `fired` 轨迹与 `overrides` 留痕（`m_vip` 对 `g_base`/`c_payx` 的两条
  override 记录）。

## 环境备注

本沙箱中子进程管道 stdout 无法被父进程捕获，CLI 测试改为重定向临时文件读取输出
（见 `test/cli.test.js` 注释）；CLI 本身直接运行输出正常。
