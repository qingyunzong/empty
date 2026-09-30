# Approval Workflow CLI

Python 3.11+ 标准库实现的审批状态机，JSON 文件持久化 + 追加式 journal。

## 参考状态表

| 当前状态 | 事件 | 下一状态 |
|---|---|---|
| RUNNING | decide approve（部分必需审批人） | RUNNING |
| RUNNING | decide approve（全部必需审批人汇合） | APPROVED |
| RUNNING | decide reject | REJECTING |
| REJECTING | 逆序补偿完成 | REJECTED |
| RUNNING | tick 达到截止时间 | TIMEOUT_CANCELING |
| TIMEOUT_CANCELING | 逆序补偿完成 | CANCELED |
| 任意 | 未处理异常 | FAILED |

- 金额 ≥ 1000：需 `manager`、`finance` 两级审批；否则仅 `manager`。
- 同一审批人重复相同决定幂等（退出码 0）；已决后相反决定退出码 9。
- 非 RUNNING 状态下的决定被拒绝（退出码 1）；模拟崩溃退出码 70。

## 命令

```sh
python approval_cli.py --store store.json new --amount 1500 --timeout 3 --items a,b,c
python approval_cli.py --store store.json tick
python approval_cli.py --store store.json decide manager approve
python approval_cli.py --store store.json crash --at after-decision   # 或 mid-compensation
python approval_cli.py --store store.json recover
python approval_cli.py --store store.json state
```

`crash --at` 武装下一次 `decide` 在决策事件落盘与动作执行之间（或补偿中途）崩溃；
`recover` 幂等重放 journal，已补偿项跳过，不会重复补偿。

## 测试

```sh
python -m unittest -v > result.txt 2>&1
```

真实运行结果见 `result.txt`（9 个测试全部通过）。
