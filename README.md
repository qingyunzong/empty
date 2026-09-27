# lease — 单资源持久化租约（fence token + 操作日志）

纯 Python 3.11 标准库实现，事件溯源（event log + snapshot）持久化到单个 JSON 文件。

## 命令

```sh
python3 lease.py [--db PATH] [--ttl SECONDS] <command>
```

- `acquire KEY` — 租约有效且同 KEY 返回同一 token；新所有者获得更大的单调 token
- `write TOKEN OPID VALUE` — token 必须等于当前 token（旧 token 退出码 9）；同 TOKEN+OPID 幂等
- `cancel` — 租约标记 CANCELED，后续 write 拒绝（退出码 10），`state` 可观察
- `renew` — 延长租约到期时间
- `release` — 逆序撤销本次租约的预留效果（op_log 追加 undo），状态 RELEASED
- `crash --at after-acquire|after-write|after-release` — 模拟崩溃，截断该事件之后的日志
- `recover` — 重放事件日志重建状态，按 KEY / OPID 去重
- `state` — 输出 JSON 状态（state/token/key/op_log/...）

## 状态与退出码

状态机：`FREE → HELD → (CANCELED | RELEASED)`，此后可重新 `acquire` 获得更大 token。

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 一般错误（如已崩溃未 recover） |
| 9 | 旧 fencing token 被拒绝 |
| 10 | 租约已取消，写被拒绝 |
| 11 | 无活动租约 / 租约被其他 KEY 持有 |

## 测试

```sh
python3 -m unittest -v > result.txt 2>&1
```

真实运行结果见 `result.txt`（19 个测试全部通过）。
