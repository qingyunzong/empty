# 单位时长任务调度器

单执行器调度至多 18 个单位时长任务。每个任务有释放时刻、截止时刻与收益，
每个任务占恰好一个整数时间槽 `s`（`release <= s < deadline`）。求解总收益
最大的可行子集；收益并列时取任务 ID 执行序列字典序最小者。仅使用 Go 标准库。

## 构建与运行

```sh
go build -o scheduler .
./scheduler        # 从 stdin 读命令，交互或脚本均可
go test ./...      # 运行测试（需可写的 GOCACHE，如 export GOCACHE=/tmp/gocache）
```

## CLI 命令

- `add <id> <release> <deadline> <profit>` 添加任务
- `remove <id>` 撤销任务（之后可重新 `solve`）
- `list` 列出当前任务
- `solve` 输出最优总收益、执行序列与时间证书（每个任务的槽位）
- `brute` 穷举所有子集的所有排列进行对照（限 n<=12）
- `verify` 校验最近一次 `solve` 的时间证书
- `clear` / `help` / `quit`

## 算法

- `Solve`：枚举全部 2^n 个子集（n<=18 即 262144 个），用"按截止升序 +
  最早可用槽位"贪心判定可行性，收益最大者胜出；并列时用 `minSequence`
  求每个候选子集字典序最小的执行序列再取最小。
- `minSequence`：每步按 ID 升序尝试候选任务，取第一个"放在最早可用槽位后
  剩余任务仍可在更晚槽位完成"的候选，得到该子集的最小执行序列。
- `BruteForce`：枚举所有子集的所有排列，用相同比较规则求最优，用于对照。
- `Verify`：校验时间证书——任务存在、槽位在 `[release, deadline)` 内、
  槽位互不冲突且递增、序列与槽位一致、收益加总正确。
- 截止时刻先收紧到 `maxRelease + n`（任何可行调度不会用到更晚的槽位）。

## 测试结果（实际运行记录）

Go 1.27.1 linux/amd64，`go test ./...` 输出：

```
ok  	scheduler	2.052s
```

`go test ./... -v` 全部通过：

```
--- PASS: TestKnownInstance (0.00s)              # 已知样例：收益 27，序列 [2 1 3]
--- PASS: TestTieBreakSmallestID (0.00s)         # 收益并列时选 ID 更小者
--- PASS: TestReleaseForcesIdle (0.00s)          # 释放时刻导致的空闲槽位
--- PASS: TestUnschedulableTask (0.00s)          # release>=deadline 不可调度
--- PASS: TestRemoveAndRecompute (0.00s)         # 撤销任务后重算与新实例一致
--- PASS: TestVerifyRejectsTampering (0.00s)     # 篡改槽位/收益/冲突均被拒绝
--- PASS: TestSolveMatchesBruteForce (1.03s)     # 500 组随机小实例与穷举对照一致
--- PASS: TestMaxSizeInstance (0.26s)            # 18 任务规模求解并验证证书
--- PASS: TestCLI (0.00s)                        # 端到端命令脚本
PASS
ok  	scheduler	1.298s
```
