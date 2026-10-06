# 对象库受控上传（额度预留 / 结算 / 单终态）

TypeScript 实现的对象库上传额度控制，零运行时依赖。

## 业务规则

- **先预留最大上传量**：`beginUpload(objectId, maxBytes)` 按最大量占用租户额度，不足即拒绝（`QuotaExceededError`）。
- **结束按实际量结算**：`finish(sessionId, actualBytes)` 核销整笔预留、按实际量计入已用，差额自动退回。
- **超预留拒绝发布**：实际量超过预留时抛出 `PublishRejectedError`，会话保持在途、额度不变，可修正后重发。
- **取消与结束只能一个终态**：会话进入 `finished` / `cancelled` 后，任何再次迁移抛出 `InvalidStateTransitionError`，额度不会二次归还。
- **租户缩额不撤已预留**：`TenantQuota.shrink()` 只收紧未来预留，在途预留与已结算量不受影响（可用额度可能为负，属正常）。
- **受控上传适配器**：`ControlledUploadAdapter` 保证额度归还恰好一次（取消幂等），旧代际句柄的取消为无操作、发布抛 `StaleGenerationError`。

## 结构

- `src/quota.ts` — 租户额度账本（预留 / 结算 / 释放 / 缩额）
- `src/objectLibrary.ts` — 对象库会话生命周期（预留 → 结束 | 取消）
- `src/controlledUploadAdapter.ts` — 受控上传适配器（代际管理、幂等取消）
- `src/errors.ts` — 领域错误类型
- `tests/` — `node:test` 测试（额度、对象库、适配器三组）
- `types/node-shims.d.ts` — 离线环境的最小 Node 类型声明

## 运行

```sh
npm test        # tsc 编译到 dist/ 后运行全部测试
npm run typecheck
```
