网格代理配置服务需要可嵌入的TypeScript策略组件，把端到端超时分配给多跳请求并传播剩余预算；每跳重试需同时受尝试上限、剩余时间和全局重试令牌约束，hedge胜出后取消其余尝试。用乱序完成与时钟推进验证不重复交付响应且总耗时不突破调用方预算。

## 组件

- `src/clock.ts` — `Clock` 接口与 `ManualClock`：`advance(ms)` 触发到期计时器，并在每个计时器后排空 microtask 队列，使时钟推进与事件循环语义一致。
- `src/tokens.ts` — `RetryTokenBucket`：全局重试令牌桶，首跳首次尝试免费，额外尝试（重试与 hedge）须持有令牌。
- `src/policy.ts` — `executeHop` / `executeRoute`：
  - `executeRoute` 把端到端预算按剩余跳数均分（`remaining / remainingHops`），逐跳传播剩余预算，任一跳失败即短路。
  - `executeHop` 的每次额外尝试同时受 `maxAttempts`、剩余时间（backoff 后仍须在截止时间之前）与令牌三重约束；`hedgeDelayMs` 后未决则发起 hedge，任一尝试胜出即 abort 其余尝试并清理全部计时器，响应恰好交付一次。
  - 截止时间为硬上限：`finishedAt - startedAt <= budgetMs` 恒成立。

## 使用

```ts
import { executeRoute, RetryTokenBucket, ManualClock } from "dlks-formal-2558";

const result = await executeRoute({
  hops: [hopA, hopB, hopC], // (input, signal) => Promise<unknown>
  policy: { maxAttempts: 3, hedgeDelayMs: 100, retryBackoffMs: 50 },
  budgetMs: 900,
  clock,
  tokens: new RetryTokenBucket(4),
});
```

## 验证

`npm test` 编译并运行 `test/policy.test.ts`：乱序完成（hedge 先胜出、主尝试迟到/失败）下不重复交付且败者被取消；时钟推进下挂起请求恰在截止时间结算，路由总耗时不突破调用方预算。
