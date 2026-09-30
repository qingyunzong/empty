# Quorum Commit Protocol CLI

Python 3.11 标准库实现的法定票数（quorum）提交协议。请求携带参与者 id 列表与法定成功数 Q，
所有事实以追加式 JSONL 事件日志（账本）持久化，内存计票始终由日志重放重建，崩溃恢复精确。

## 命令

```bash
python3 quorum.py --ledger ledger.jsonl start --participants p1 p2 p3 --quorum 2
python3 quorum.py --ledger ledger.jsonl vote p1 SUCCESS   # 或 FAIL
python3 quorum.py --ledger ledger.jsonl crash --at vote  # vote | final | compensate
python3 quorum.py --ledger ledger.jsonl recover
python3 quorum.py --ledger ledger.jsonl state
```

## 状态机

- `COLLECTING`：收票中。
- 成功票达到 Q：持久化 `finalizing`（FINALIZING）→ `completed`（COMPLETED），并取消（cancel）所有未投票参与者（其结局为 CANCELED）。
- 失败票达到 N-Q+1（成功永不可能）：持久化 `failed`（FAILED），并补偿（compensate）所有已投 SUCCESS 的参与者。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功（含重复投票返回首次结果） |
| 2  | 用法/前置条件错误 |
| 4  | 同一参与者相反票冲突 |
| 9  | 终态确定后的迟到票（账本不变） |
| 70 | 模拟崩溃（事件已持久化后进程猝死） |

## 崩溃与恢复

`crash --at EVENT` 仅允许三个崩溃点：`vote`（投票事件后）、`final`（终态事件后）、
`compensate`（补偿事件后）。崩溃指令写入 `<ledger>.crash`，下一个匹配事件 fsync 落盘后
进程立即 `os._exit(70)`。`recover` 清除崩溃指令、重放日志并以幂等方式补齐缺失的
finalizing/completed/failed/cancel/compensate 事件，票数由日志精确重建。

## 测试

```bash
python3.11 -m unittest -v test_quorum
```

测试包含小规模参考计票枚举：对 N=3、Q=2 枚举全部投票序列（参与者排列 × 票值组合），
每投一票后用独立的参考计票函数对照 CLI 的实际状态与票数。真实结果见 `TEST_RESULTS.md`。
