# margin-call

保证金追缴库与 CLI。Node.js 22，仅标准库与 `node:test`。

## 语义

- 目标金额固定，按账户 `priority`（升序，同优先级按 `id`）依次冻结 `min(剩余目标, available)`。
- 每个账户的冻结记录在落盘（原子写入 + fsync）后才处理下一个账户；部分成功立即记录。
- 遍历结束后：累计 ≥ 目标 → `CONFIRMED` 并输出证书（含 sha256 摘要）；不足 → 按冻结相反顺序全部撤销，状态 `FAILED`。
- `faults.crashAfterAccount = i`：第 i 个账户（按优先级排序后）的冻结记录落盘后模拟崩溃（库抛 `SimulatedCrashError`，CLI 退出码 1）。用同一事件与日志目录重跑即可从下一账户继续，不重复冻结。
- `faults.cancelAfterAccount = i`：处理完第 i 个账户后收到 CANCEL，停止后续冻结并撤销已冻结部分，状态 `CANCELLED`（`i = -1` 表示立即取消）。
- 同一 `callId` 幂等：已完成的调用直接返回存档结果；同一 `callId` 携带不同事件会被拒绝（`CALL_ID_CONFLICT`）。

## 用法

```sh
node src/cli.js <event.json|-> <logDir>   # 成功: stdout 输出结果 JSON, 退出码 0
                                          # 失败: stderr 输出错误 JSON, 退出码 1
```

事件格式：

```json
{
  "callId": "mc-1",
  "targetAmount": 100,
  "accounts": [{ "id": "a", "priority": 1, "available": 50 }],
  "faults": { "crashAfterAccount": null, "cancelAfterAccount": null }
}
```

## 测试

```sh
node --test
```

测试包含独立暴力枚举器：枚举账户余额 × 故障点 × 取消点的小规模组合（1080 例），
与参考模型逐字段比对冻结/回退集合，并断言非确认状态下无孤儿冻结。
