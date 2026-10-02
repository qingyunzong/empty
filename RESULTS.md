# 测试结果（RESULTS）

- 运行环境：Node.js v22.22.1，仅标准库，`node:test`，离线单机
- 测试命令：`node --test`
- 测试时间：2026-10-02

## 汇总

| 指标 | 结果 |
| --- | --- |
| 测试文件 | 2（`test/machine.test.js`、`test/cli.test.js`） |
| 子测试总数 | 17（machine 12 + cli 5） |
| 通过 | 17 |
| 失败 | 0 |

`node --test` 输出摘要：

```
# tests 2
# pass 2
# fail 0
```

## 验收标准对照

| # | 验收标准 | 对应测试 | 结果 |
| --- | --- | --- | --- |
| 1 | 全额撤销后再撤销恢复余额与可撤销额度 | `acceptance 1: full reversal then reinstate restores balance and capacity`（tx 100 → 撤销 100 → 再撤销 100，余额回到 100，可撤销区间 [0,100]） | 通过 |
| 2 | 两笔部分撤销边界到 0，超出即拒 | `acceptance 2: two partial reversals hit exact 0 boundary, next one rejected`（60+40=100 到 0，再撤 1 报 `E_AMOUNT`） | 通过 |
| 3 | 乱序按 (logicalClock,eventId) 重放，穷举 3 事件全排列（6 种）结果一致 | `acceptance 3: out-of-order submission replays ... all 3-event permutations agree`（6 种排列 final.stateHash 与证书链完全一致） | 通过 |
| 4 | 伪造 prevHash 校验失败 | `acceptance 4: forged prevHash fails verification with E_CERT` + CLI 级 `cli verify exits 1 with E_CERT for forged prevHash` | 通过 |

## 其他覆盖

- 同一 eventId 重复提交幂等（仅应用一次，记入 `duplicates`）
- 再撤销不得超过该撤销实际撤销额（即不越过原交易上限），超出报 `E_AMOUNT`
- 引用未知交易哈希报 `E_UNKNOWN_TX`；引用未知撤销哈希报 `E_UNKNOWN_REVERSAL`
- 相同 logicalClock 按 eventId 字典序定序
- 证书链自 genesis 起 prevHash→certHash 逐环链接
- 篡改事件金额、篡改 final 余额均报 `E_CERT`
- 非法事件（负金额、未知类型、非对象）报 `E_BAD_EVENT`
- CLI：apply 输出 JSONL 证书流；错误写 stderr 且退出码 1；usage 错误退出码 1

## CLI 冒烟（手动验证）

```
node cli.js apply events.jsonl state.json   # 乱序 3 事件 → 输出 3 行 JSONL 证书
node cli.js verify state.json               # {"ok":true,"certsChecked":3,...}，退出码 0
# 篡改 state.json 中任一 prevHash 后：
node cli.js verify state.json               # stderr: E_CERT: certificate mismatch at seq 0，退出码 1
```
