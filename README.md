# FSM Failure Minimizer

诊断 CLI：给定有限状态机（FSM）表和一个失败事件序列，通过**删除连续块并重测**
（delta-debugging 风格）把序列缩减到 **1-最小**——结果中再删除任意单个事件都不再失败。
非法历史（对 FSM 而言不存在对应转移的序列）**不会**被当作失败。

只使用 TypeScript + Node.js 内置库（`node:fs`、`node:crypto`、`node:test` 等），无运行时依赖。

## 用法

```sh
npm run build          # tsc -p tsconfig.json（使用全局 tsc）
node dist/src/cli.js --fsm examples/fsm.json --events examples/events.json --trace trace.jsonl
```

参数：

- `--fsm`：状态机表 JSON，格式
  `{ "initial": string, "failureStates": string[], "transitions": { state: { event: nextState } } }`
- `--events`：失败事件序列，JSON 字符串数组或 `{ "events": [...] }`
- `--trace`：判断轨迹输出路径（默认 `trace.jsonl`）

退出码：`0` 缩减成功；`1` 参数/IO/校验错误；`2` 输入序列本身不失败
（未到达失败状态，或历史非法——非法历史不算失败）。

## 判定（oracle）

从初始状态重放事件序列：

- 某一步转移未定义 → `invalid`（非法历史，绝不视为失败）
- 全部重放后停在 `failureStates` → `fail`
- 否则 → `pass`

## 缩减算法

`src/minimize.ts` 中的确定性算法：从粒度 2 开始把序列切成连续块，逐块尝试删除，
删除后仍 `fail` 则接受并降低粒度；一轮无进展则加倍粒度。只有当块大小为 1
（即已逐一测试所有单事件删除）且全部不再失败时才终止，因此结果保证 1-最小。
随后 `verifyOneMinimal` 独立复验每个单事件删除，结果写入轨迹。

## 判断轨迹（可复现）

每次 oracle 判定都按 JSONL 追加到轨迹文件：相同输入产生逐字节相同的轨迹。

```json
{"type":"config","algorithm":"contiguous-block-ddmin","fsmSha256":"ab93d44e...","input":["noop","open","read","lock","noop","write"]}
{"type":"test","id":1,"sequence":["noop","open","read","lock","noop","write"],"verdict":"fail"}
{"type":"verify","id":16,"removedIndex":0,"removedEvent":"open","verdict":"invalid"}
{"type":"result","inputLength":6,"outputLength":3,"minimized":["open","lock","write"],"totalTests":18,"oneMinimal":true}
```

## 测试

```sh
npm test    # tsc 编译后运行 node --test
```

覆盖：oracle 三种判定（含非法历史不算失败）、FSM 表校验、缩减到 1-最小、
缩减过程不接受非法历史、两次运行轨迹完全一致（确定性）、CLI 端到端与错误退出码。

## 实际运行结果（2026-10-05 记录）

```
$ npm test
ok 1 - dist/test/cli.test.js
ok 2 - dist/test/fsm.test.js
ok 3 - dist/test/minimize.test.js
ok 4 - dist/test/oracle.test.js
# tests 4
# pass 4
# fail 0

$ node dist/src/cli.js --fsm examples/fsm.json --events examples/events.json
minimized (6 -> 3 events, 18 oracle tests):
["open","lock","write"]
```

示例中 `["noop","open","read","lock","noop","write"]` 被缩减为
`["open","lock","write"]`：删 `open` 或 `lock` 得到非法历史（`invalid`），
删 `write` 则 `pass`——每个单事件删除都不再失败。
