# 实际测试结果记录

环境：Node.js v22.22.1，npm 9.2.0，tsc 7.0.2（全局 typescript@7.0.2）。
日期：2026-10-05。命令均在工作区根目录实际执行，退出码 0。

## `npm test`（tsc 编译 + node --test）

```
> generational-round-runtime@1.0.0 test
> npm run build && node --test "dist/test/*.test.js"

> generational-round-runtime@1.0.0 build
> tsc -p tsconfig.json

TAP version 13
# Subtest: dist/test/runtime.test.js
ok 1 - dist/test/runtime.test.js
# tests 1
# pass 1
# fail 0
```

测试文件内 6 个用例（`node dist/test/runtime.test.js` 直跑明细）：

```
ok 1 - round end waits for stream drain before completing
ok 2 - explicit truncation terminates a round that cannot drain
ok 3 - late stdout/assertion/exit are attributed only to their original round
ok 4 - a closed generation cannot write into a new round
ok 5 - each round has exactly one terminal state
ok 6 - out-of-order simulation emits complete citation evidence
# tests 6
# pass 6
# fail 0
```

## `npm run simulate`：乱序模拟的完整引用证据与唯一轮终态

```
=== Citation evidence (complete, in recording order) ===
E1   t001 round-1  gen=1 msg=-                state-transition           lifecycle: round opened (generation 1)
E2   t002 round-1  gen=1 msg=-                state-transition           lifecycle: open -> closing; waiting for stream drain or explicit truncation
E3   t003 round-1  gen=1 msg=r1:stdout:2      accepted                   stdout: applied to round-1 (phase=closing, seq=2)
E4   t004 round-1  gen=1 msg=r1:stdout:1      accepted                   stdout: applied to round-1 (phase=closing, seq=1)
E5   t005 round-1  gen=1 msg=-                state-transition           lifecycle: terminal: truncated — deadline exceeded while waiting for stream drain
E6   t006 round-2  gen=2 msg=-                state-transition           lifecycle: round opened (generation 2)
E7   t007 round-1  gen=1 msg=-                rejected-stale-handle      write: stale gen-1 handle tried to emit stdout; round is truncated; rejected — not attributed to round-2 (gen 2)
E8   t008 round-1  gen=1 msg=-                rejected-stale-handle      write: stale gen-1 handle tried to emit assertion; round is truncated; rejected — not attributed to round-2 (gen 2)
E9   t009 round-2  gen=2 msg=-                state-transition           lifecycle: open -> closing; waiting for stream drain or explicit truncation
E10  t010 round-1  gen=1 msg=r1:assertion:5   late-attributed            assertion: arrived after round-1 terminated (truncated); filed on original round as evidence only, state unchanged
E11  t011 round-1  gen=1 msg=r1:exit:6        late-attributed            exit: arrived after round-1 terminated (truncated); filed on original round as evidence only, state unchanged
E12  t012 round-1  gen=1 msg=r1:stdout:3      late-attributed            stdout: arrived after round-1 terminated (truncated); filed on original round as evidence only, state unchanged
E13  t013 round-1  gen=1 msg=r1:assertion:4   late-attributed            assertion: arrived after round-1 terminated (truncated); filed on original round as evidence only, state unchanged
E14  t014 round-2  gen=2 msg=r2:stdout:1      accepted                   stdout: applied to round-2 (phase=closing, seq=1)
E15  t015 round-2  gen=2 msg=r2:stdout:2      accepted                   stdout: applied to round-2 (phase=closing, seq=2)
E16  t016 round-2  gen=2 msg=r2:assertion:3   accepted                   assertion: applied to round-2 (phase=closing, seq=3)
E17  t017 round-2  gen=2 msg=r2:exit:4        accepted                   exit: applied to round-2 (phase=closing, seq=4)
E18  t018 round-2  gen=2 msg=-                state-transition           lifecycle: terminal: completed — streams drained (final stdout chunk + exit received)
E19  t019 round-2  gen=2 msg=-                rejected-duplicate-terminal lifecycle: attempted 'truncated' but round-2 is already terminal (completed); unique terminal state preserved
E20  t020 round-99 gen=99 msg=r99:stdout:1     dropped-unknown-round      stdout: no such round; message dropped

=== Unique terminal state per round ===
round-1 (gen 1): TRUNCATED — deadline exceeded while waiting for stream drain
    applied: stdout chunks=2, assertions=0, exit code=none
    late messages filed on this round: [r1:assertion:5, r1:exit:6, r1:stdout:3, r1:assertion:4]
round-2 (gen 2): COMPLETED — streams drained (final stdout chunk + exit received)
    applied: stdout chunks=2, assertions=1, exit code=0
    late messages filed on this round: [none]
```

证据要点：

- E3/E4：乱序到达（seq=2 先于 seq=1），仍归属原轮并被接受。
- E5：round-1 未排空，经显式截断进入唯一终态 `truncated`。
- E7/E8：关闭后的 gen-1 句柄写入被拒绝，证据明确引用受保护的新轮 round-2。
- E10–E13：迟到的 stdout/断言/退出消息只记入 round-1（`late-attributed`），不改状态。
- E18：round-2 排空后唯一终态 `completed`；E19：重复终止被拒绝。
- E20：不存在轮次的消息被丢弃并留证。
