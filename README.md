# evidence-claims

科研证据声明的增量校验库及 CLI。Node.js 22，仅标准库与 `node:test`，全程离线。

## 模型

- **证据**：`{ id, weight, active }`，`addEvidence` 为 upsert（重复添加幂等，权重冲突以全序最后者为准），`retractEvidence` 置为 inactive。
- **声明**：`all` / `any` / `quorum`（阈值）节点，`refs` 可动态引用证据或其他声明（`addEdge` 幂等、`removeEdge` 可移除）。
- **历史**：两位操作者产生的带 Lamport 时钟的操作序列。系统按 `(clock, agentId, canonical(op))` 确定全序后重放，结果与输入文件内分支顺序无关。
- **增量**：撤回或边变更沿反向依赖边传播失效（dirty set），仅重算受影响声明。
- **错误**：环返回 `E_CYCLE`，未知引用返回 `E_REF`，错误沿依赖向上传播。
- **证书**：满足时给出最小支撑证据集（≤20 个活跃证据时精确枚举，超出退化为结构化贪心）；不满足时给出拒绝原因链；均附带状态哈希（SHA-256，规范化序列化）。

## 操作

```json
{ "clock": 1, "agentId": "alice", "op": "addEvidence", "id": "e1", "weight": 2 }
{ "clock": 2, "agentId": "alice", "op": "retractEvidence", "id": "e1" }
{ "clock": 3, "agentId": "bob", "op": "defineClaim", "id": "c1", "type": "quorum", "threshold": 4 }
{ "clock": 4, "agentId": "bob", "op": "addEdge", "claim": "c1", "ref": "e1" }
{ "clock": 5, "agentId": "bob", "op": "removeEdge", "claim": "c1", "ref": "e1" }
```

历史文件为操作数组或 `{ "ops": [...] }`；多文件按全序合并。

## CLI

```sh
node src/cli.js state <history.json...>            # 重放合并历史，输出状态 JSON（含 stateHash）
node src/cli.js cert <claimId> <history.json...>   # 输出该声明的证书 JSON
node src/cli.js order <history.json...>            # 输出确定全序后的操作序列
```

## 库

```js
import { Engine } from './src/engine.js';
import { totalOrder } from './src/order.js';
import { certificate } from './src/certificate.js';

const engine = new Engine().applyAll(totalOrder(ops));
engine.statusOf('c1');        // { satisfied, error }
engine.stateHash();           // sha256 hex
certificate(engine, 'c1');    // { satisfied, minimalSupport | reasons, stateHash }
```

## 测试

```sh
node --test
```

- `test/certificate.test.js`：≤7 声明时，最小支撑集与枚举所有证据子集的结果对照（120 个随机场景）。
- `test/order.test.js` / `test/cli.test.js`：分叉历史合并结果只取决于确定全序。
- `test/errors.test.js`：并发撤回、成环、阈值为 0、未知引用的可复验状态。
- `test/incremental.test.js`：每个操作后增量状态与全量重放一致。
