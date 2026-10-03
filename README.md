# alarm-gateway

离线产线网关的事件缓存与报警匹配引擎。Node.js 22，仅标准库（`node:crypto`、
`node:test` 等），无第三方依赖，单机离线运行。

## 模型

- **事件缓存**：`upsert{id,ts,sym}` 写入/覆盖事件（同 id 后写覆盖前写），
  `retract{id}` 撤销事件（id 不存在即错误，重复 retract 同属此类）。
- **滑动窗口**：`setWindow{n}`（`n >= 1`）设定窗口容量。窗口是缓存的纯视图：
  按 `(ts, id)` 排序后取最近 `n` 条。乱序补录、迟到、撤销都只改变有效事件集，
  窗口内容随之确定性地重算，与到达顺序无关。
- **多模式匹配**：支持 `substring`（子串字面量）、`wildcard`（`?` 匹配单字符、
  `*` 匹配任意序列）、`regex`（正则片段）三类模式。对窗口内符号序列的每个
  连续子序列做全串匹配；允许重叠，同一事件可参与多个模式、多个匹配。
- **增量更正**：每条输入应用后重算报警集合并与前一集合 diff，只输出必要变更
  （`emit` / `retractAlarm`），不全清重发；无变化时仅输出 `windowHash`。
- **证书**：每个报警附带 `cert`（模式 id、起止事件 id/ts、匹配文本、输入指纹
  `fingerprint` = 跨度事件 `[[id,ts,sym],...]` 的 SHA-256），可用
  `verifyCert(cert, windowEvents, patterns)` 独立复核。
- **windowHash**：当前窗口事件规范序列化后的 SHA-256，只取决于有效事件集与
  窗口容量，与 upsert/retract 的交错顺序无关（可重放校验）。

## 输入格式（JSONL）

```jsonl
{"upsert":{"id":"e1","ts":1,"sym":"A"}}
{"retract":{"id":"e1"}}
{"setWindow":{"n":3}}
```

## 输出格式（JSONL）

每条输入记录处理后，先输出撤回的报警（若有），再输出新增报警（若有），
最后输出一行窗口哈希。同一批复内报警按 `(起始下标, 结束下标, 模式id)` 排序，
顺序确定。

```json
{"type":"emit","alarm":{"patternId":"sub-AB","startId":"e1","endId":"e2"},"cert":{"patternId":"sub-AB","startId":"e1","endId":"e2","startTs":1,"endTs":2,"text":"AB","fingerprint":"6db3b9bd..."}}
{"type":"retractAlarm","alarm":{"patternId":"sub-AB","startId":"e1","endId":"e2"},"cert":{...}}
{"type":"windowHash","hash":"72381d69...","size":3,"window":3}
```

## 运行

```bash
node --test                                        # 全部测试
node cli.js events.jsonl                           # 无模式（仅 windowHash）
node cli.js events.example.jsonl --patterns patterns.example.json
```

模式文件为 JSON 数组：

```json
[
  { "id": "sub-AB", "type": "substring", "value": "AB" },
  { "id": "wild-A?C", "type": "wildcard", "value": "A?C" },
  { "id": "re-Bplus", "type": "regex", "value": "B+" }
]
```

## 错误与退出码

- 输入校验错误（`ts` 非整数、窗口 `< 1`、retract 不存在的 id、重复 retract、
  非法 JSON、未知操作等）：stderr 输出 `{"type":"error","message":...}`，退出码 **3**。
- 用法错误（参数缺失、文件不可读）：退出码 **2**。

实测：

```text
$ node cli.js bad-ts.jsonl
{"type":"error","message":"line 1: upsert a: ts must be an integer, got: 1.5"}
exit=3
$ node cli.js bad-win.jsonl
{"type":"error","message":"line 1: window size must be an integer >= 1, got: 0"}
exit=3
$ node cli.js bad-retract.jsonl   # 重复 retract
{"type":"error","message":"line 3: retract of unknown id: a"}
exit=3
```

## 库 API

```js
import { Gateway, verifyCert, InputError } from './src/engine.js';

const g = new Gateway({ patterns, windowSize: Infinity });
const outputs = g.apply({ upsert: { id: 'e1', ts: 1, sym: 'A' } }); // 输出行对象数组
g.getWindowEvents(); // 当前窗口事件（按 ts,id 排序）
g.getWindowHash();   // 当前窗口哈希
g.getAlarms();       // 当前报警集合 Map
g.verify(cert);      // 复核证书
```

## 验收与实测结果

测试环境：Node.js v22.22.1。`node --test` 实测输出：

```text
ok 1 - test/cli.test.js
ok 2 - test/engine.test.js
# tests 2
# pass 2
# fail 0
```

子测试（15 个，全部通过）：

```text
ok 1 - overlapping patterns all reported in deterministic order
ok 2 - same event participates in multiple patterns and multiple matches
ok 3 - window sliding evicts old matches via retractAlarm
ok 4 - out-of-order upsert inserts by timestamp and only outputs the delta
ok 5 - upsert override recomputes affected alarms incrementally
ok 6 - input validation errors raise InputError with exitCode 3
ok 7 - certificates verify independently and reject tampering
ok 8 - random small logs (n<=12) match brute-force enumeration of all subsequences
ok 9 - interleaved upsert/retract hash equals replay of final effective set
ok 1 - CLI processes a valid log and emits JSON lines
ok 2 - CLI exits 3 on non-integer ts
ok 3 - CLI exits 3 on window < 1
ok 4 - CLI exits 3 on duplicate retract
ok 5 - CLI exits 3 on retract of unknown id and on invalid JSON
ok 6 - CLI exits 2 on usage errors
```

对应四项验收：

1. **重叠模式都报告且顺序确定**：`sub-AB` / `re-3sym` / `wild-A?C` 同时命中
   `ABC`，emit 顺序恒为 `(起始, 结束, 模式id)` 字典序（测试 1、2）。
2. **窗口滑动驱逐旧匹配**：`setWindow{2}` 下第三条事件到达时，旧匹配
   `sub-AB(a,b)` 输出 `retractAlarm`，新匹配 `sub-BC(b,c)` 输出 `emit`（测试 3）。
3. **随机小日志对照暴力枚举**：200 个种子、每条日志不超过 12 个操作
   （upsert/retract/setWindow 混合），逐操作与暴力枚举所有连续子序列的
   预言机比对报警集合、emit/retract 影子集合、windowHash 及证书指纹（测试 8）。
4. **交错后哈希等于重放**：100 个种子的 upsert/retract 交错日志，最终
   windowHash 与报警集合等于把最终有效事件集（按序及乱序两种方式）重放的
   结果（测试 9）。

## 文件结构

- `src/engine.js` — 事件缓存、窗口视图、报警重算与 diff、证书与哈希
- `src/patterns.js` — substring / wildcard / regex 模式编译
- `src/errors.js` — `InputError`（`exitCode = 3`）
- `cli.js` — JSONL 命令行入口（亦导出 `run(argv, io)` 供测试）
- `test/engine.test.js`、`test/cli.test.js` — `node:test` 测试
- `events.example.jsonl`、`patterns.example.json` — 示例输入
