# RESULT

测试时间（UTC）：2026-10-02T15:56:03Z
环境：v22.22.1，仅标准库，单机离线
命令：`node --test`

## 测试结果（真实输出）

```
✔ test/acceptance-a.test.js   A: 继承+冲突混合 50 请求，逐条对照参照实现并校验证据
✔ test/acceptance-b.test.js   B: 撤销后重放历史一致；紧急停机撤销回溯生效
✔ test/acceptance-c.test.js   C: 伪造“应拒绝却允许”记录被 verifyRecord 检出；反例可重放翻转
✔ test/acceptance-d.test.js   D: n≤8 规则枚举 2^n 真值表（1530 组）与参照实现一致
✔ test/cli.test.js            CLI 端到端 + 退出码 2/3/4

tests 6 / pass 6 / fail 0
```

## CLI 冒烟（examples/）

```
evaluated 7 requests: 2 allow, 5 deny
decisions -> /tmp/result-decisions.jsonl
audit     -> /tmp/result-audit.log
```

audit.log 首三行：

```
time=2026-01-05T10:00:00Z id=rq-001 subject=alice device=press1 action=openMold decision=deny reason=rule-deny winners=r-deny-cellA overridden=r-base-open:less-specific,r-wild-deny:less-specific conflict=- retro=- cex=policy:removeRules(r-deny-cellA)
time=2026-01-05T10:05:00Z id=rq-002 subject=bob device=press2 action=openMold decision=allow reason=rule-allow winners=r-base-open overridden=r-wild-deny:less-specific conflict=- retro=- cex=policy:removeRules(r-base-open)
time=2026-01-05T10:10:00Z id=rq-003 subject=alice device=press1 action=heatUp decision=deny reason=conflict-deny winners=r-heat-deny overridden=r-heat-allow:conflict-deny-default,r-wild-deny:less-specific conflict=allow[r-heat-allow]deny[r-heat-deny]->deny retro=- cex=policy:removeRules(r-heat-deny)
```
