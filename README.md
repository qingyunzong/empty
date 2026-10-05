# test-explainer 测试解释库

断言失败时给出**最小原因切片**与**可重放证据**的 TypeScript 库, 仅依赖 Node.js 内置模块。

## 特性

- **多输入依赖追踪**: 通过 `Proxy` 动态记录测试实际读取的输入键。
- **最小原因切片**: 断言失败时, 对依赖切片贪心穷举移除输入, 直至任一移除都无法复现同一失败 (1-最小)。
- **未执行分支不计来源**: 条件未执行分支中的输入从未被读取, 自然不进入依赖切片。
- **错误与断言失败分开**: `AssertionFailure` 归类为 `failure` 并产出原因切片; 其他异常 (含 `MissingInputError`) 归类为 `error`, 不产出切片。
- **自包含切片**: 读取缺失输入会抛出 `MissingInputError`, 保证切片包含重放所需的全部输入。
- **至多 20 输入**: 超过即拒绝, 保证穷举移除验证的开销有界。
- **可重放证据**: 证据含最小输入集、逐键必要性验证结果与重放确认; `replayEvidence(fn, evidence)` 可独立重放。

## 使用

```ts
import { explain, assertThat, replayEvidence, type Inputs } from './src/explain.ts';

const fn = (inputs: Inputs) => {
  const total = (inputs.price as number) * (inputs.qty as number);
  assertThat(total <= (inputs.budget as number), `over budget: ${total} > ${inputs.budget}`);
};

const evidence = explain('cart total', fn, {
  price: 30, qty: 4, budget: 100, userId: 'u-1', note: 'gift',
});
// evidence.status === 'failure'
// evidence.accessedInputs === ['price', 'qty', 'budget']  (userId/note 未被读取)
// evidence.reason.inputs === { price: 30, qty: 4, budget: 100 }
// evidence.reason.replay.reproduced === true
replayEvidence(fn, evidence); // true
```

注意: 被解释的测试函数必须是确定性的 (相同输入产生相同结果), 否则重放证据无效。

## 构建与测试

```sh
npm test        # tsc 编译到 dist/ 后用 node:test 运行全部测试
npm run build   # 仅编译
```

环境说明: 本机 Node v22.22.1 未内置 TypeScript 类型剥离支持, 因此先用 tsc (7.0.2) 编译再运行; 离线环境无 `@types/node`, `types/node-shim.d.ts` 提供所需的最小类型声明。

## 实际测试结果 (2026-10-05, Node v22.22.1)

```
ok 1 - 断言依赖多个输入: 失败时返回最小原因切片
ok 2 - 条件未执行分支中的输入不计入来源
ok 3 - 读取缺失输入视为错误, 与断言失败区分
ok 4 - 错误与断言失败分开: 普通异常不产生原因切片
ok 5 - 显式抛出的非断言错误同样归类为 error
ok 6 - AssertionFailure 是断言失败的标记类型
ok 7 - 测试通过时状态为 pass 且无原因切片
ok 8 - 超过 20 个输入时拒绝解释
ok 9 - 恰好 20 个输入时仍可穷举移除验证
ok 10 - 多输入共同作用: 切片保留全部必要输入
ok 11 - 证据可序列化为 JSON 用于存档与重放
# tests 11
# pass 11
# fail 0
```

## 证据样例 (实际输出)

```json
{
  "test": "cart total",
  "status": "failure",
  "accessedInputs": ["price", "qty", "budget"],
  "reason": {
    "inputs": { "price": 30, "qty": 4, "budget": 100 },
    "removedInputs": [],
    "minimalityChecks": [
      { "removed": "price", "reproduced": false },
      { "removed": "qty", "reproduced": false },
      { "removed": "budget", "reproduced": false }
    ],
    "failure": { "message": "over budget: 120 > 100" },
    "replay": { "reproduced": true, "message": "over budget: 120 > 100" }
  }
}
```
