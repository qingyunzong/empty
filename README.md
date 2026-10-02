# margin-call

保证金追缴库与 CLI。Node.js 22，仅使用标准库与 `node:test`。

## 语义

- 追缴目标金额固定，按账户 `priority`（数值小者优先，并列按 `id`）依次冻结可用资金。
- 每个账户的冻结尝试（成功、部分成功、失败）立即以写前日志落盘（`<logDir>/<callId>.jsonl`，追加写 + fsync）。
- 遍历结束后：累计冻结 ≥ 目标 → `CONFIRMED` 并出具证书（对规范化冻结明细的 SHA-256）；不足 → 按冻结相反顺序全部撤销，状态 `FAILED`。
- `crashAfterAccount=N`：第 N 个账户（按优先级序，1 起）冻结记录落盘后模拟崩溃；重启后从下一账户继续，不重复冻结。
- `cancelAfterAccount=N`：第 N 个账户处理完后收到 CANCEL，停止后续冻结并撤销已冻结部分，状态 `CANCELLED`。
- 同一 `callId` 幂等：已完成的追缴直接返回存档结果；参数冲突的相同 `callId` 被拒绝。

## 事件 JSON

```json
{
  "callId": "call-1",
  "targetAmount": 100,
  "accounts": [{ "id": "a", "priority": 1, "available": 60, "failFreeze": false }],
  "crashAfterAccount": null,
  "cancelAfterAccount": null
}
```

## CLI

```sh
node cli.js '<event-json 或事件文件路径>' <日志目录>
```

成功时向 stdout 输出结果 JSON（含 `status`、`freezes`、`rollbacks`、`certificate`），退出码 0；
出错时向 stderr 输出 `{"error": "..."}`，退出码 1。模拟崩溃后 CLI 自动重启续跑至完成。

## 测试

```sh
node --test
```

`test/enumerator.test.js` 使用独立枚举器，对账户余额 × 故障点 × 取消点的小规模组合（4320 例）
暴力计算期望冻结/回退集合，与引擎实际结果逐一比对，并校验无孤儿冻结。
