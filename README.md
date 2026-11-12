# EDF+ 式记录的精确解码与区间定位

本包提供纯 TypeScript、无外部依赖的增量记录解码器。它不诊断、不绘图，只负责：

- 按通道顺序读取每记录的小端 `int16` 样本；
- 精确解析记录末尾的 TAL/注释区；
- 校验记录起点与记录间时序；
- 对已提交记录做任意有理半开区间 `[L, R)` 的样本段和事件查询。

所有时间、物理量转换和区间边界均使用 `BigInt` 有理数，不经过浮点数。

## 输入头

宿主负责解析 EDF 文本头。模块只接收规范化后的结构：

```ts
interface ChannelSpec {
  name?: string;
  ns: number;                 // 每记录正整数样本数
  digitalMin: RationalInput;
  digitalMax: RationalInput;
  physicalMin: RationalInput;
  physicalMax: RationalInput;
}

interface RecordHeaderSpec {
  mode: "C" | "D";            // 连续 / 间断
  recordDuration: RationalInput; // 正有理 T
  channels: ChannelSpec[];    // 文件中的普通通道顺序
  annotationBytes: number;    // 标注通道容量 a，a >= 4
}
```

`RationalInput` 可以是 `Rational`、`bigint`、数字或 `"n/d"`/十进制字符串。数字只在必要时使用，建议头部配置传字符串以避免浮点表示误差。

每记录字节布局固定为：

```text
channel[0]: ns[0] 个 little-endian int16
channel[1]: ns[1] 个 little-endian int16
...
annotation: a bytes
```

原始 `int16` 可以超出声明的 digital 范围。转换公式严格为：

```text
pmin + (raw - dmin) * (pmax - pmin) / (dmax - dmin)
```

不裁剪结果。`pmax < pmin`（负增益）也被精确支持。

## 使用

```ts
import { RecordDecoder } from "./index.js";

const header = {
  mode: "D" as const,
  recordDuration: "1/3",
  annotationBytes: 64,
  channels: [
    {
      name: "EEG",
      ns: 2,
      digitalMin: -2048,
      digitalMax: 2047,
      physicalMin: "-100",
      physicalMax: "100",
    },
    {
      name: "ECG",
      ns: 3,
      digitalMin: 0,
      digitalMax: 4095,
      physicalMin: "5",
      physicalMax: "-5", // 负增益，仍逐样本精确转换
    },
  ],
};

const decoder = new RecordDecoder(header);

// 任意字节切块；完整且校验通过的记录才会提交。
for await (const chunk of sourceChunks) {
  const newlyCommitted = decoder.push(chunk);
  console.log("committed records:", newlyCommitted.map((record) => record.index));
}
decoder.finish(); // 若残留半条记录则抛 INCOMPLETE_RECORD

// [1, 2) 内的样本段。每段对应一条记录中的一个通道。
const segments = decoder.querySamples("1", "2");
for (const segment of segments) {
  console.log({
    recordIndex: segment.recordIndex,
    channelIndex: segment.channelIndex,
    indexRange: [segment.indexStart, segment.indexEnd], // 半开: start <= k < end
    firstTime: segment.firstTime.toString(), // 例如 "1"
    lastTime: segment.lastTime.toString(),
    byteOffset: segment.byteOffset,
    byteLength: segment.byteLength,
  });
}

// onset 落入 [0, 3) 的事件，按记录号、TAL 号、注释号稳定排序。
const events = decoder.queryEvents("0", "3");
for (const event of events) {
  console.log({
    recordIndex: event.recordIndex,
    talIndex: event.talIndex,
    annotationIndex: event.annotationIndex,
    onset: event.onset.toString(),
    duration: event.duration === undefined ? "absent" : event.duration.toString(),
    text: event.text,
  });
}

// 按字节偏移读取原始 int16，或取得精确转换后的有理物理量。
console.log(decoder.readSample(0, 0, 0));
console.log(decoder.sampleValue(0, 0, 0).toString());
```

`querySamples` 与 `queryEvents` 的区间都是半开区间。`L > R` 抛出 `QueryRangeError`，`L === R` 返回空数组。样本查询用整数算术直接求每个通道的索引段，不展开、不遍历全部样本。

## 时间与顺序规则

- 通道 `j` 的样本 `k` 时刻为 `s + k * T / ns[j]`，不同采样率不做强行对齐。
- 首记录起点必须满足 `0 <= s < 1`。
- C 模式要求下一条记录起点恰为 `previousStart + T`。
- D 模式要求下一条记录起点 `>= previousStart + T`；允许间隙，不允许重叠。
- 记录间隙不生成零样本。
- 事件 onset 可负、可超出本记录范围；它不会改变样本的时间基准。
- 事件查询只按 onset 选择，不按 duration 是否与区间相交选择。
- 缺失 duration 为 `undefined`；显式 `"0"` 为 `Rational.ZERO`，二者不同。

## TAL 与错误原子性

标注区中的记录起点来自第一条 TAL。第一条 TAL 必须严格为：

```text
onset 0x14 0x14 0x00
```

它的空注释只作为记录起点，不产生事件。后续 TAL 至少需要一条非空注释；每个注释（含空串、重复文本）都会生成事件。时间字段使用严格十进制字面量：

```text
onset:    [+-][0-9]+(.[0-9]+)?
duration: [0-9]+(.[0-9]+)?
```

注释仅允许 TAB、LF、CR 作为控制字符；非法 UTF-8、其他 U+0000..U+001F、注释中的 0x15、未终止注释等都会被拒绝。TAL 边界处的 0x00 之后所有字节必须为零填充。

解码器是原子提交的：只有整条记录（样本区和标注区）全部通过校验后，记录才会进入 `decoder.records`。后续记录失败时：

- 之前提交的记录仍保留并可查询；
- 失败记录的样本或事件不会出现；
- 解码器进入失败状态，后续 `push`/`finish` 抛出同一 `DecodeError`。

`DecodeError.code` 可取 `INVALID_HEADER`、`TAL_TRUNCATED`、`TIME_FORMAT`、`INVALID_UTF8`、`FIRST_TAL`、`EMPTY_TAL`、`INVALID_PADDING`、`RECORD_START_ORDER`、`INCOMPLETE_RECORD` 等。

## API 摘要

- `new RecordDecoder(header)`：创建增量解码器。
- `push(chunk: Uint8Array)`：提交本次调用能完成并通过校验的记录。
- `finish()`：确认没有半条残留记录。
- `records`：已提交记录（只读视图）。
- `querySamples(from, to)`：返回 `SampleSegment[]`，空段省略。
- `queryEvents(from, to)`：返回 `DecodedEvent[]`，稳定排序。
- `readSample(record, channel, k)`：原始 `int16`。
- `readSamples(record, channel, start, count)`：连续原始样本。
- `sampleValue(record, channel, k)`：精确 `Rational` 物理量。
- `readRecordBytes(record)`：记录字节的防御性副本。
- `decodeAll(header, bytes, chunkSize?)`：一次性便捷入口。

记录号、通道号、TAL 号、注释号均从 0 开始。第一条 TAL 的 `talIndex` 为 0，其注释不产生事件。

## 测试

```bash
npm test
```

测试使用独立的有理数参考实现逐样本核对，覆盖多速率、负增益、非零首记录小数起点、D 模式间隙、C 模式起点误差、跨记录事件、空注释、duration 缺失与 0、零填充、非整数边界切块、部分记录、原子失败和精确端点。
