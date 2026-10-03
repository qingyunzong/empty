# 测试结果（真实运行记录）

环境：Node.js v22.22.1，Linux x86_64，单机离线，零第三方依赖。
命令：`node --test`（Node 22 内置 test runner）。

最近一次运行汇总：

```
# tests 2        (2 个测试文件)
# pass 2
# fail 0
# duration_ms ~6000
```

## test/sim.test.js（12 项，全部通过）

```
ok 1 - happy path: inbound occupies target, outbound frees source, move relocates
ok 2 - acceptance 2: cancel of started task keeps target reserved until safe_point
ok 3 - cancel of started outbound compensates goods back to source at safe_point
ok 4 - idempotency: repeated cancel returns the same result, ledger written once
ok 5 - idempotency: duplicate assign/start/finish are no-ops with cached result
ok 6 - acceptance 4: cancel of done task -> INVALID_STATE recorded, run continues
ok 7 - acceptance 3: blocked aisle defers finishes; unblock drains by priority then arrival, reproducibly
ok 8 - acceptance 3b: equal priority falls back to arrival order
ok 9 - exit-order comparator: full tie broken by task_id
ok 10 - acceptance 1: enumerate interleavings of 3 tasks / 2 aisles, slots stay consistent
ok 11 - slot conflict: two tasks cannot reserve the same target
ok 12 - cancel of queued (blocked exit) task is compensated at safe_point and skipped on unblock
```

其中 acceptance 1 实际执行 3360 次完整模拟：1680 种保序交错（9!/(3!)^3）+ 1680 种注入 block/unblock 窗口的变体，每个事件后校验货位不变量。

## test/cli.test.js（5 项，全部通过）

```
ok 1 - CLI: clean run exits 0 and writes final_slots.json + ledger.jsonl, no errors.jsonl
ok 2 - CLI: cancel of done task -> errors.jsonl with INVALID_STATE, exit 2, run continues
ok 3 - CLI: blocked-aisle convergence is recorded in ledger with deterministic exit_order
ok 4 - CLI: malformed events.jsonl line -> PARSE_ERROR, exit 2
ok 5 - CLI: usage error exits 1
```

## 端到端冒烟（手工 CLI 运行）

`node cli.js sim --in <dir> --out <dir>` 对 3 任务（入库/移库/出库）+ block/unblock + 两类取消的场景：
- 阻塞期间两个 finish 挂起，unblock 后按优先级 `["MV1","IN1"]` 汇合放行；
- assigned 任务取消立即成功，后续 start 记 `INVALID_STATE`；
- done 任务取消记 `INVALID_STATE`；
- 进程 exit=2，`errors.jsonl` 含 2 条错误，`final_slots.json` 货位一致（无两位同货位）。
