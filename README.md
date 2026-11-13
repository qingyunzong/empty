# 字段级敏感标签传播

治理管线需要可导入的 TypeScript 标签传播组件，标签带来源、置信度、用途限制和降敏规则。concat/hash/tokenize/aggregate 等变换使用各自传播函数，不能简单取并集；冲突标签按偏序保留多个最大元素。输出每个标签的推导证据图。

## 用法

```ts
import { Propagator, type FieldSet, type Label } from "./index.ts";

const p = new Propagator();
const email: FieldSet = p.register({
  name: "email",
  labels: [
    {
      id: "pii.email",
      category: "sensitivity",
      level: "confidential",
      scope: "record",
      source: { kind: "scanner", scanner: "pii-scanner" },
      confidence: 0.9,
      purposes: { allowed: ["billing"], denied: ["ads"] },
      declassify: [{ transform: "hash", action: "downgrade", toLevel: "internal" }],
    },
  ],
});

const hashed = p.hash("email_hash", email);        // 单向：置信度衰减 + 降敏规则
const token = p.tokenize("email_token", email);    // 可逆：标签原样传播
const joined = p.concat("profile", [hashed, token]);
const stats = p.aggregate("stats", [joined]);      // record 级标签默认丢弃

// 每个输出标签的推导证据子图（可 toDot() 导出 Graphviz）
const evidence = p.evidenceFor("profile", "pii.email");
console.log(evidence.toDot());
```

## 传播语义

- `concat`：并列保留全部输入标签；同 id 标签按 noisy-or `1 - Π(1 - c)` 合并置信度，用途限制取交集。
- `hash`：单向伪名化，置信度按 `hashConfidenceFactor`（默认 0.8）衰减，并应用标签上的 `declassify` 规则（keep / downgrade / drop）。
- `tokenize`：可逆置换，标签与置信度原样传播。
- `aggregate`：`record` 级标签默认丢弃（可用 `declassify` 规则显式 keep），`cohort`/`dataset` 级保留；同 id 置信度取最弱链路 min。
- 每次变换后执行冲突消解：同 id 合并后按偏序（同 category 按 level 全序，跨 category 不可比）保留所有极大元素。

## 脚本

- `npm run typecheck`：类型检查。
- `npm test`：编译到 `build/` 后运行 `node --test`。
