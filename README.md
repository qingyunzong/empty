# alarm-window-gateway

单机离线的事件报警网关：缓存设备事件，在滑动窗口内同时维护多个报警模式
（子串 / 通配 / 正则片段），对乱序补录与更正事件做**增量**重算，只输出必要
的报警变更（`emit` / `retractAlarm`），避免重复通知。

仅使用 Node.js 22 标准库，测试基于 `node:test`，无第三方依赖。

## 运行

```bash
node --test                          # 全部测试
node cli.js events.jsonl             # 使用内置默认模式
node cli.js events.jsonl pats.json   # 使用自定义模式文件
```

## 输入（JSONL，每行一个操作）

```json
{"upsert":{"id":"e1","ts":100,"sym":"BOOT"}}
{"retract":{"id":"e1"}}
{"setWindow":{"n":3}}
```

- `upsert`：写入事件；同一 `id` 后写覆盖前写（更正）。`ts` 必须为整数，
  `sym` 必须为字符串。
- `retract`：撤销事件；`id` 不存在（含重复 retract）即错误。
- `setWindow`：窗口大小 `n`，必须为 ≥1 的整数。窗口 = 按 `(ts, id)` 排序
  后的最后 `n` 个有效事件。未设置前窗口视为无界。

错误（`ts` 非整数、`n < 1`、retract 未知 id、非法 JSON 等）打印到 stderr
并以**退出码 3** 结束；参数/文件错误退出码 2。

## 模式定义

模式文件是 JSON 数组。每个模式由若干片段组成，每个片段匹配一个符号，
模式整体按**子序列**匹配窗口符号流（允许重叠，同一事件可参与多个模式、
多个匹配）：

```json
[
  {"id":"boot-then-crit","parts":[{"lit":"BOOT"},{"any":true},{"lit":"CRIT"}]},
  {"id":"err-pair","parts":[{"re":"^ERR"},{"re":"^ERR"}]}
]
```

- `{"lit":"X"}`：子串匹配，`sym.includes("X")`
- `{"any":true}`：通配，匹配任意符号
- `{"re":"^ERR"}`：正则片段，`new RegExp(re).test(sym)`

## 输出（JSONL，每行一条变更）

```json
{"op":"emit","cert":{"pattern":"boot-then-crit","start":"e1","end":"e3","events":["e1","e2","e3"],"fp":"948e35086e3f8715"},"windowHash":"a46c14ec4dc0bcba"}
```

- 每次状态变更后重算窗口内全部匹配，与上一报警集合做 diff：只输出
  `retractAlarm`（先，已失效）与 `emit`（后，新出现），无变化则无输出。
  输出顺序确定：先按模式 id、再按事件 id 序列字典序。
- `cert` 为匹配证书：`pattern` 模式 id、`start`/`end` 起止事件 id、
  `events` 参与事件 id 序列、`fp` 输入指纹（匹配事件的
  `[id,ts,sym]` 序列之 SHA-256 前 16 位十六进制），可独立复核。
- `windowHash`：当前窗口内容（窗口大小 + 窗口内事件 `[id,ts,sym]` 序列）
  的 SHA-256 前 16 位。它只依赖最终有效事件集与窗口大小，与历史操作
  顺序无关——乱序 upsert/retract 交错后的哈希等于按最终有效集重放。

## 设计

- `src/engine.js`：`Engine`（状态、窗口、增量 diff）、`compilePattern`
  （模式编译）、`findMatches`（子序列枚举匹配）、`EngineError`（exitCode 3）。
- `src/defaults.js`：CLI 缺省模式。
- `cli.js`：导出 `runCli(argv, io)` 供进程内测试；直接执行时接 process 流。

## 验收与真实测试记录

以下为本仓库实际运行结果（Node v22.22.1）：

```
$ node --test
# tests 3        # 3 个测试文件
# pass 3
# fail 0
```

子测试共 19 个，全部通过（`test/engine.test.js` 8、`test/brute.test.js` 3、
`test/cli.test.js` 8），覆盖四条验收标准：

1. **重叠模式都报告且顺序确定** — `engine.test.js`：三个模式（子串/通配/
   正则）同时命中同一对事件，输出按 `(pattern, events)` 排序且两次运行
   完全一致；同一事件参与 `aa` 的全部三对匹配与 `aaa`。
2. **窗口滑动驱逐旧匹配** — `engine.test.js`：窗口 n=2 时第 3 个事件进入，
   旧匹配只收到一条 `retractAlarm`，无关状态变化不产生任何输出；
   `setWindow` 收缩/扩张同样只产生增量变更。
3. **随机小日志对照暴力枚举** — `brute.test.js`：150 个种子，每个 1–12 个
   事件、随机乱序写入、随机窗口与 1–3 个随机模式，引擎匹配集合与独立
   实现的“枚举全部 2^n 子序列再过滤”结果逐一相等；另有随机交错
   upsert/retract 60 组与 diff 输出流回放校验。
4. **交错后哈希等于最终有效集重放** — `engine.test.js` 与 `brute.test.js`：
   覆盖写、迟到写、撤销交错后，`windowHash`、窗口内容与报警集合均等于
   用最终有效事件集全新重放的结果。

CLI 端到端示例（`test/cli.test.js` 断言退出码与输出结构）：

```
$ node cli.js demo.jsonl        # 含乱序补录、撤销、覆盖写
{"op":"emit","cert":{"pattern":"boot-then-crit","start":"e1","end":"e3","events":["e1","e2","e3"],"fp":"948e35086e3f8715"},"windowHash":"a46c14ec4dc0bcba"}
{"op":"retractAlarm","cert":{"pattern":"boot-then-crit","start":"e1","end":"e3","events":["e1","e2","e3"],"fp":"948e35086e3f8715"},"windowHash":"2aa16bd2964477c5"}

$ node cli.js bad.jsonl         # ts 非整数
error: line 1: upsert.ts must be an integer, got 1.5
exit=3
```
