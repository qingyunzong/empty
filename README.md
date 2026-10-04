# alert-intervals

告警库:对信号保持序列,输出值大于阈值且持续至少 `d` 个 tick 的区间,并携带起止证据。
纯 TypeScript,运行时仅依赖 Node.js 内置库(`node:test` / `node:assert`),无任何 npm 依赖。

## 语义

- **持续至少 d**:一段连续 tick 上每个值都 `> threshold`,且长度 `>= minDuration`,才输出告警区间 `[startTick, endTick]`;区间随持续延长(`extended` 事件)。
- **缺失打断**:区间内任何 tick 无数据(隐式空洞)或被显式 `missing` 事件标记,都会打断持续段。
- **同 tick 先更正再判定**:同一批次中同一 tick 的多个事件,按 observation → correction → missing 的顺序应用,判定只看到更正后的最终状态。
- **迟到事件撤回**:迟到的 correction / missing 若破坏了已告警的区间,引擎发出 `retracted` 事件撤回该告警;若区间起点因此改变,则先撤回旧告警再升起新告警。
- **起止证据**:每个区间携带
  - `startEvidence.sample` / `endEvidence.sample`:区间首末 tick 的实测值;
  - `startEvidence.before` / `endEvidence.after`:边界外相邻 tick 的状态,`reason` 为 `below-threshold` | `missing` | `series-start` | `open`(`open` 表示数据尚未到达,区间可能继续延长)。

## API

```ts
import { AlertEngine } from "./src/index.ts";

const engine = new AlertEngine(/* threshold */ 10, /* minDuration */ 3);
const events = engine.ingest([
  { kind: "observation", tick: 1, value: 11 },
  { kind: "observation", tick: 2, value: 12 },
  { kind: "correction",  tick: 2, value: 0 }, // 同 tick 更正,先应用再判定
  { kind: "missing",     tick: 5 },           // 显式缺失,打断持续段
]);
// events: Array<{ type: "raised" | "extended" | "retracted", alert: AlertInterval }>
engine.activeAlerts(); // 当前活动告警区间(含起止证据)
```

## 与逐 tick 模型对照

- `src/alertEngine.ts`:引擎实现。基于超阈值位图 + 双指针扫描提取区间,增量地对活动告警做 diff,发出 raised / extended / retracted。
- `src/reference.ts`:独立的逐 tick 参照模型(`TickByTickModel`),用显式状态机逐 tick 推进,作为对照 oracle。
- `tests/crossCheck.test.ts`:多个随机种子下,逐批注入观测/更正/缺失混合事件(含迟到事件),**每一批之后**断言引擎活动告警与逐 tick 模型输出完全一致,并校验 活动告警数 = 升起数 − 撤回数。

## 运行

```sh
npm test        # tsc 编译到 dist/ 后用 node --test 运行
npm run typecheck
```

## 实际测试结果

环境:Node.js v22.22.1,tsc 7.0.2,Linux。`npm test` 实际输出(2026-10-05 运行):

```
> tsc -p tsconfig.build.json && node --test dist/tests/*.test.js

ok 1 - dist/tests/alertEngine.test.js
ok 2 - dist/tests/crossCheck.test.js
# tests 2
# pass 2
# fail 0
```

逐用例明细(直接运行编译产物):

```
ok 1 - 值大于阈值持续至少 d 才输出区间
ok 2 - 缺失打断持续区间
ok 3 - 同 tick 先应用更正再判定
ok 4 - 迟到事件撤回告警
ok 5 - 迟到更正使区间起点变化时撤回旧告警并升起新告警
ok 6 - 告警携带起止证据
# tests 6  # pass 6  # fail 0

ok 1 - 引擎输出与逐 tick 模型逐步对照(随机事件流,含迟到与更正)
ok 2 - 对照:同 tick 混合事件批次下两模型一致
# tests 2  # pass 2  # fail 0
```

`npm run typecheck`(`tsc --noEmit`,strict 模式)通过,无错误。
