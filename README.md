# As-of join（容差、并列与水位）

可直接接入 TypeScript 时间序列服务的 as-of join 组件。

## 语义

- 对每个左事件，在相同 `key` 的右版本中选择**不晚于左事件时间**、且满足
  `leftTime - rightTime <= tolerance` 的最新版本。
- 多个右版本时间相同时，按 `sourceSeq` 裁决；默认取最大 source sequence
  （最新来源版本）。可用 `tieBreak: "min-source-seq"` 反转。
- 右值可乱序到达。组件以 `maxObservedEventTime - allowedLateness` 维护有界
  水位，水位之内的乱序右值先被有序索引后再参与 join。
- 左事件时间被水位越过（`watermark > leftTime`）后结果即封闭并输出。之后
  再到达的迟到右值默认丢弃（`latePolicy: "drop"`），不会改写已输出结果；
  `latePolicy: "keep"` 仅允许其服务未来左事件，同样不会回写旧结果。
- `close()` 会 flush 所有待定左事件并封闭输入流。

## 流式用法

```ts
import { AsOfJoin } from "dlks-de-0113";

const join = new AsOfJoin({
  tolerance: 30_000,        // 30s 容差
  allowedLateness: 10_000,  // 10s 有界乱序
});

join.addRight({ key: "AAPL", time: 1000, sourceSeq: 1, value: 101 });
join.addRight({ key: "AAPL", time: 990, sourceSeq: 2, value: 100.5 });

// 新增事件可能推进水位；返回值是本次新封闭的左结果。
const closed = join.addLeft({ key: "AAPL", time: 1020, value: "trade" });

// 输入结束时收尾。
const final = join.close();
console.log([...closed, ...final], join.results);
```

也可使用 `push()` 接收带标签的事件：

```ts
join.push({ type: "right", key: "AAPL", time: 1100, sourceSeq: 3, value: 102 });
join.push({ type: "left", key: "AAPL", time: 1120, value: "trade" });
join.push({ type: "watermark", time: 2000 });
```

## 批量用法

```ts
import { asOfJoin } from "dlks-de-0113";

const results = asOfJoin(leftEvents, rightEvents, {
  tolerance: 30_000,
});
```

批量入口会完整索引右侧数据，右值输入顺序无关；结果按左事件输入顺序返回。
每个结果形如 `{ left, right, matched, key, leftTime, rightTime, rightSourceSeq }`，
未匹配时 `right` 为 `null`。

## 可配置项

- `tolerance`：容差，默认 `0`。
- `allowedLateness`（或 `maxOutOfOrderness`）：有界水位延迟，默认 `0`。
- `tieBreak`：`"max-source-seq"`（默认）或 `"min-source-seq"`。
- `latePolicy`：`"drop"`（默认）或 `"keep"`。
- `key` / `time` / `sourceSeq`：自定义字段访问器；默认支持
  `key`、`time`/`timestamp`/`ts`、`sourceSeq`/`sequence`/`seq`。
- `onResult`：每输出一个结果回调一次。

```bash
npm test
```
