# RESULT — 机器人焊接单元模式切换安全解释器

日期：2026-10-02 ｜ 环境：Node.js v22.22.1，仅标准库，单机离线，未安装任何依赖。

## 交付物

- `src/interpreter.js` — 解释器库：消费事件流，维护 当前模式 / 门磁 / 光幕 / 钥匙权限快照，
  产出 transitions 与 violations（含被丢弃事件及原因）。
- `src/enumerate.js` — 序列枚举器 + 安全不变量对照（验收 D）。
- `src/counterexample.js` — 非法自动启动的最少事件前缀搜索（BFS，按长度+字典序，首个命中即最短）。
- `cli.js` — CLI：`node cli.js <mode-events.jsonl> [outDir]` 写出 `transition.jsonl` 与
  `violations.jsonl`；`node cli.js --counterexample [depth]` 搜索反例。
- `test/` — node:test 测试（解释器语义、验收 A/B/C、CLI 错误码、验收 D 枚举）。

## 核心语义落实

- 权限继承 班组→工位→机器人：班组钥匙覆盖全部 scope；工位钥匙覆盖 工位+机器人；
  机器人钥匙仅机器人。模式切换需 station scope，自动启动需 robot scope。
- 维护模式允许开门（door 事件正常记录），但禁止自动启动（violation:
  "maintenance mode forbids automatic start"）。
- 示教限速（安全规则 250 mm/s）与产能规则冲突时安全规则胜：超速请求被截断并记 violation。
- 钥匙撤销立即生效（快照即刻更新，auto 中失去 robot 权限立即进入减速）；
  已开始的减速窗口（2 拍）必须完成，窗口内模式请求/自动启动被丢弃，不得中途跳变。
- 同一逻辑时钟内并发事件按 (安全等级降序, 来源字典序, 序号升序) 决议；
  被高优先级事件挤掉的事件以 kind="discarded" 连原因写入 violations.jsonl。
- 反例：`findIllegalAutoStart` 对 ≤N 长度全部序列做 BFS，返回导致非法自动启动的最短前缀；
  安全解释器在深度 9 内无反例（349524 条序列），naive 变体返回最短前缀长度 2。

## 错误码（实测）

| 场景 | 命令 | 退出码 |
|---|---|---|
| 未知模式 `mode:"fly"` | `node cli.js bad13.jsonl` | 13 |
| 时钟非单调 2→1 | `node cli.js bad14.jsonl` | 14 |
| 同时钟门磁开/关矛盾 | `node cli.js bad15.jsonl` | 15 |

## 测试真实结果（`node --test`，2026-10-02 实跑）

```
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js      (1590 ms)
# Subtest: test/enumerate.test.js
ok 2 - test/enumerate.test.js       (15298 ms)
# Subtest: test/errors.test.js
ok 3 - test/errors.test.js          (7684 ms)
# Subtest: test/interpreter.test.js
ok 4 - test/interpreter.test.js     (1701 ms)
# tests 4   # pass 4   # fail 0
# duration_ms 15495
```

共 16 个断言级测试用例，全部通过：

- 验收 A（开门请求自动启动被拒）：`test/acceptance.test.js` — 门开时 mode_request→auto
  与 auto_start 均被拒，最终 mode=maintenance、running=false，2 条 violation。
- 验收 B（撤销钥匙后恢复流程）：撤销后权限快照立即为空、进入减速窗口且模式不跳变；
  窗口在 clock≥end 时完成后落为维护模式；重新授予钥匙→切 auto→自动启动成功。
- 验收 C（同刻三事件确定性）：[auto_start, door open, mode_request] 的 6 种到达顺序
  产生完全一致的 transition/violations 输出；门磁（安全等级最高）胜出，其余两条被 discarded。
- 验收 D（≤9 事件序列枚举对照）：4 事件字母表上枚举全部 349525 条序列（长度 0..9），
  逐条对照安全不变量（运行时门必闭/光幕必通/必持 robot 权限/不在减速窗内、
  示教限速 ≤250、维护模式零速），failures = 0。

## CLI 冒烟（实跑）

```
$ node cli.js mode-events.jsonl .
processed 9 events: 10 transitions, 1 violations/discards
final: mode=auto door=closed curtain=clear running=true speedLimit=2000 keys=K2@team
exit=0
$ node cli.js --counterexample 6
no illegal automatic start up to depth 6 (checked 5460 sequences)
```

注：测试环境沙箱会吞掉子进程管道 stdout/stderr，CLI 测试改用文件重定向捕获输出
（`test/errors.test.js`），不影响 CLI 本身行为。
