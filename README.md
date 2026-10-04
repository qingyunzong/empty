# event-compressor

按 key 合并连续版本事件的压缩库（TypeScript + Node.js 内置库，零依赖）。

## 模型

输入是「事件 / 屏障」交错的有序流：

- **事件** `{ kind: 'event', id, key, value: Uint8Array }`：某个 key 的一个版本。
- **屏障** `{ kind: 'barrier', id }`：显式标记，压缩合并**禁止跨越**。

## 压缩 `compress(items) -> CompressedItem[]`

相邻且同 key 的连续事件合并为一个段（Segment），屏障会冲刷当前段并原样保留：

```ts
interface Segment {
  kind: 'segment';
  key: string;
  firstValue: Uint8Array; // 初值：段内第一个事件的值
  lastValue: Uint8Array;  // 终值：段内最后一个事件的值
  ids: number[];          // 被合并事件的 id，保持原顺序
}
```

中间版本的值被丢弃（这正是压缩点）；顺序信息（id、key、屏障位置）无损。

## 逆压缩 `decompress(items) -> OrderEntry[]`

按原顺序展开段与屏障，还原事件顺序。配合 `orderOf`（提取输入顺序）与
`serializeOrder`（确定性字节编码：`0x45|id:u64be|keyLen:u16be|utf8(key)`，屏障为
`0x42|id:u64be`）可做字节级一致性核对：

```ts
serializeOrder(decompress(compress(input))) === serializeOrder(orderOf(input))
```

## 使用

```ts
import { compress, decompress, orderOf, serializeOrder } from './src';

const compressed = compress([
  { kind: 'event', id: 1, key: 'a', value: Uint8Array.from([1]) },
  { kind: 'event', id: 2, key: 'a', value: Uint8Array.from([2]) },
  { kind: 'barrier', id: 3 },
  { kind: 'event', id: 4, key: 'a', value: Uint8Array.from([9]) },
]);
// => [ segment{key:'a', ids:[1,2], first:[1], last:[2]}, barrier{3}, segment{key:'a', ids:[4], ...} ]
```

## 测试

```sh
npm test   # tsc 编译 + node --test（node:test / node:assert，无第三方依赖）
```

覆盖：同键合并（初值/终值/被合并 id）、异键不合并、屏障禁止跨越、逆压缩还原顺序、
字节编码格式、空输入/全屏障、非法 id 拒绝，以及 **500 组随机用例**（固定种子
mulberry32，随机屏障 + 4 键交错 + 随机值），逐组断言：

1. 还原后字节序列与原顺序字节序列完全一致；
2. 压缩输出不存在相邻同 key 段（合并充分、屏障切分正确）；
3. 每段初值/终值与被合并首/末事件的值一致。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出（`node --test` 将测试文件汇总为一个子测试，通过）：

```
# tests 1
# pass 1
# fail 0
```

文件内全部用例明细（`node dist/test/codec.test.js`）：

```
ok 1 - 同 key 连续事件合并为一段，输出初值、终值与被合并 id
ok 2 - 不同 key 的相邻事件不合并
ok 3 - 屏障禁止跨越：同 key 被屏障隔开时分成两段
ok 4 - 逆压缩还原原事件顺序（含屏障位置）
ok 5 - 顺序字节序列：编码格式稳定
ok 6 - 空输入与全屏障输入
ok 7 - 非法 id 在序列化时被拒绝
ok 8 - 随机屏障与同键交错：还原后字节序列一致，且段不跨屏障
# tests 8
# pass 8
# fail 0
```
