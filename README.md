# evalcheck

评估证据校验库（Go）。校验题面哈希、运行产物哈希与评分字段的关联，并对签名回执做信任版本与撤销检查。

## 规则

- **关联链**：`version -> problem_hash -> artifact_hash -> score -> receipt`，每一跳在 `Report.Chain` 中记录状态与位置，拒绝原因在 `Report.Rejections`（含字段位置）。
- **评分**：必须为整数 1–5；缺字段或缺证据时结论为 `incomplete`，校验器绝不自动补评分或评价结论。
- **版本**：版本更新后旧版本证据一律判 `rejected`（`version` 位置）。
- **签名回执**：回执绑定清单摘要、签名者与信任版本；只有签名验证通过、且对应信任版本在签名时刻未被撤销的证据才有效。
- **异步与回执防回滚**：`Service` 按证据 ID 维护代际（generation），迟到的异步验证结果不会覆盖更新状态；`ApplyReceipt` 拒绝不晚于当前回执的旧回执（`ErrStaleReceipt`）。
- **签名适配器**：`Adapter` 接口可插拔；内置 `HMACAdapter` 与可编程的 `ControlledAdapter`（测试/集成用）。

## 测试

```sh
go test ./...
```
