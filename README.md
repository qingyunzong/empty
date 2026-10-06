# reserved-upload-library

对象库预留式上传与受控上传适配器（TypeScript，零运行时依赖）。

## 规则实现

- **先预留最大上传量**：`ObjectLibrary.beginUpload({ maxBytes })` 先在 `TenantQuotaLedger` 预留 `maxBytes`，额度不足抛 `QuotaExceededError`，不产生会话。
- **结束按实际量结算**：`session.finish()` / `library.commit(session)` 按实际发布量计入 `used`，差额归还预留。
- **超预留拒绝发布**：`session.publish(bytes)` 累计超过 `maxBytes` 抛 `ReservationExceededError`，会话保持 `open`。
- **取消和结束只能一个终态**：会话状态机 `open -> finished | cancelled`，进入任一终态后所有操作抛 `TerminalStateError`，额度不会被重复归还。
- **租户缩额不撤已预留**：`ledger.setLimit()` 调低只约束新的预留；在途预留保留，可正常结算或释放。
- **额度归还一次**：`UploadHandle.finish()/cancel()` 幂等——重复结束返回同一回执、重复取消为空操作，底层账本恰好结算/归还一次。
- **旧代际取消**：`ControlledUploadAdapter.start()` 为同一对象键开启新代际时自动取代（supersede）旧代际并取消其会话；旧句柄的写与结算抛 `StaleGenerationError`，取消为安全空操作。

## 结构

- `src/quota.ts` — 租户额度账本（预留 / 结算 / 释放 / 缩额）
- `src/objectLibrary.ts` — 对象库与上传会话状态机
- `src/adapter.ts` — 受控上传适配器（代际管理、幂等终态）
- `test/` — node:test 用例（`test/node-shims.d.ts` 为最小 Node 类型声明）

## 运行

```sh
npm test   # tsc 编译到 dist/ 后以 node --test 执行全部用例
```
