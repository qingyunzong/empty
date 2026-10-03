# RESULTS

日期：2026-10-03（UTC）· Node v22.22.1 · 命令：`node --test`

## 测试摘要（真实输出）

```
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5895.888627
```

3 个测试文件、30 个子测试全部通过：

- `test/limit.test.js`（13 个子测试）
  - A: partial captures aggregate, release frees the remainder
  - A: capture up to the exact remainder closes the auth
  - A: freeze cannot exceed available credit (E_LIMIT)
  - B: expiry boundary at exactly ttl (lazy, event time)
  - B: sweep boundary matches lazy boundary exactly
  - B: extend pushes expiry out; expired auth cannot be extended
  - B: lazy expiry and periodic sweep converge to identical state
  - B: pending (never captured, not yet expired) auth is not a failure
  - D: failed operations never change frozen/used
  - D: E_EXPIRED capture releases the remainder but adds nothing to used
  - state transitions on closed auths raise E_STATE
  - MAX_OPS is 20000
  - 20000 operations execute sequentially
- `test/linearize.test.js`（8 个子测试）
  - C: checker agrees with exhaustive 3-op permutations（6 个场景，
    与 3! 全排列穷举 oracle 逐一比对，含见证序列回放校验）
  - C: real-time precedence constrains the serial order
  - C: witness respects precedence when multiple orders are legal
- `test/cli.test.js`（9 个子测试）
  - run 成功 exit 0 并输出最终状态；--explain 逐操作轨迹
  - E_LIMIT / E_EXPIRED / E_STATE 均 exit != 0 且 stderr 含错误码
  - 超过 20000 操作拒绝执行；check 输出 LINEARIZABLE + 见证 /
    NOT_LINEARIZABLE；用法错误 exit 2

## 验收对照

- **A 部分 capture + release 聚合**：freeze 500 → capture 200 ×2 →
  release，断言 frozen 500→100→0、used 0→400、available 复原正确。
- **B 到期边界 exactly ttl**：`t = freeze.time + ttl - 1` 可 capture；
  `t = freeze.time + ttl` 报 E_EXPIRED 且剩余自动释放；sweep 边界一致；
  惰性与定时扫描最终状态 deepEqual。
- **C 并发日志判定**：6 个全并发 3 操作场景与穷举全排列 oracle 结果
  完全一致；另有实时序约束（`end < start`）强制顺序的接受/拒绝用例。
- **D 失败操作无副作用**：8 类失败操作逐一断言 frozen/used 不变；
  E_EXPIRED 的 capture 只触发到期释放、不增加 used。

## CLI 实测

```sh
$ node bin/limit.js run examples/ops.jsonl --explain
{"line":1,"op":{"op":"open",...},"ok":true,...}
...
{"ok":true,"ops":5,"state":{"accounts":{"a":{"creditLimit":1000,
 "frozen":0,"used":400,"available":600,...}}}}
# exit=0

$ node bin/limit.js check examples/log.jsonl --limit 100
LINEARIZABLE
witness: ["f","c","r"]
# exit=0

$ node bin/limit.js run /tmp/expired.jsonl --limit 100
line 2: E_EXPIRED: capture: auth expired: au1
# exit=1
```

注：沙箱禁止 node 内再 spawn node，CLI 测试通过 `src/cli.js` 导出的
`runCli(argv, io)` 进程内调用完成（返回退出码）；`bin/limit.js` 为薄
封装，上述命令已在 shell 中实测。
