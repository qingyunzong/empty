# consensus — 法定人数共识账本 CLI

仅依赖 Python 3.11 标准库。以追加式 JSONL 事件日志为唯一事实来源，
所有状态均由日志重放重建，因此崩溃恢复是精确的。

## 命令

```bash
python3.11 consensus.py start --participants p1 p2 p3 --quorum 2 [--log PATH]
python3.11 consensus.py vote p1 SUCCESS [--log PATH]   # 或 FAIL
python3.11 consensus.py crash --at VOTE [--log PATH]   # VOTE | FINAL | COMPENSATE
python3.11 consensus.py recover [--log PATH]
python3.11 consensus.py state [--log PATH]             # JSON 输出
```

## 状态机

- `COLLECTING`：收票中。
- `FINALIZING`：成功票达到 Q 后先持久化该状态，再取消未投票参与者并写 `COMPLETED`。
- `COMPLETED`：成功终态；未投票参与者记为 `canceled`。
- `FAILED`：失败票达到 N-Q+1（成功永不可能）时进入；已投 SUCCESS 的参与者记为 `compensated`（补偿）。
- `CANCELED`：参与者维度状态，体现在 `state` 输出的 `canceled` 列表。

## 语义

1. 成功票达到 Q 立即汇合：持久化 `finalizing` → `cancel` 未投票者 → `completed`。
2. 失败票达到 N-Q+1 时：为每个已投 SUCCESS 者写 `compensate`，再写 `failed`。
3. 终态确定后的迟到票：退出码 9，账本不变。
4. 同一参与者重复同票：幂等返回首次结果（退出码 0）；相反票冲突：退出码 4，账本不变。
5. 崩溃点仅限投票事件后（`VOTE`）、终态事件后（`FINAL`）、补偿事件后
   （`COMPENSATE`）；`crash --at` 武装一次性崩溃点，下一个匹配事件以
   退出码 3 模拟宕机；`recover` 依据日志重建票数并幂等地完成终态流程。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功（含重复票幂等返回首次结果） |
| 2  | 用法错误（未启动、未知参与者、非法 Q 等） |
| 3  | 模拟崩溃已触发 |
| 4  | 冲突票（与首次投票相反） |
| 9  | 终态确定后的迟到票 |

## 测试

```bash
python3.11 -m unittest -v
```

测试包含小规模参考计票枚举对照：对 N∈{2,3}、每个合法 Q，枚举所有
投票顺序与 SUCCESS/FAIL 组合，逐票比对实现状态与独立参考计票函数，
并验证终态后的投票均以退出码 9 拒绝。真实运行结果见 `TEST_RESULTS.md`。
