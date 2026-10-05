# canonical-bytes

签名清单用的规范字节编码库：把**整数、字节串、数组、对象**转为唯一的规范字节序列，
用于稳定摘要与签名。纯 TypeScript，仅依赖 Node.js 内置模块（`node:crypto`、`node:test`），零第三方依赖。

## 编码格式

每个值 = 1 字节类型标签 + 内容。所有长度/计数均为**最小化无符号 LEB128 varint**（最长 10 字节，64 位）。

| 类型   | 标签   | 内容                                                     |
| ------ | ------ | -------------------------------------------------------- |
| 整数   | `0x69` | zigzag 变换后的 varint（`number` 须为安全整数；`bigint` 限 int64 范围） |
| 字节串 | `0x62` | varint 长度 + 原始字节                                   |
| 数组   | `0x61` | varint 元素数 + 依次拼接的元素编码                       |
| 对象   | `0x6f` | varint 键值对数 + 按键排序后的条目（varint 键长 + 键 UTF-8 字节 + 值编码） |

规范性约束（编码器与解析器同时强制）：

- **键按 UTF-8 字节序排序**（不是 UTF-16 码元序）：`'a' < 'aa' < 'z' < 'é'`。
- **拒绝重复键**：`obj(entries)` 构造时与解析字节流时都会拒绝。
- **拒绝无效代理项**：键必须是 well-formed Unicode，孤立代理项（lone surrogate）抛 `CanonicalError`；
  解析时非法 UTF-8（含 CESU-8 式代理项编码）同样拒绝。
- 解析器额外拒绝：非最小化 varint、乱序键、未知标签、截断输入、值后的尾随字节。

## API

```ts
import {
  encodeCanonical,   // 迭代式主编码器：CanonicalValue -> Buffer
  encodeRecursive,   // 独立递归编码器（交叉测试用），输出与主编码器逐字节一致
  CanonicalParser,   // 流式解析器：write(chunk) / tryParse() / end()
  parseCanonical,    // 一次性解析完整缓冲区
  digestCanonical,   // 值的 SHA-256 摘要（与对象插入顺序无关）
  digestBytes,       // 已编码字节的摘要
  obj,               // 从键值对列表构造对象，校验重复键与代理项
  CanonicalError,    // 所有编码/解析错误；err.offset 为绝对字节偏移
} from './src/index.js';
```

### 流式解析与错误偏移

`CanonicalParser` 接受任意分块（可逐字节喂入），`tryParse()` 在数据不足时返回 `null`，
出错时抛出带**绝对流偏移**的 `CanonicalError`——偏移跨分块累计，不受分块边界影响：

```ts
const parser = new CanonicalParser();
parser.write(chunk1);
parser.write(chunk2);           // 错误即使发生在 chunk2 中间，offset 也是全流绝对偏移
const { value, bytesConsumed } = parser.tryParse();
```

### 摘要与插入顺序无关

对象键在编码前排序，因此同一逻辑对象无论以何种顺序插入键，摘要都相同：

```ts
digestCanonical(obj([['b', 1], ['a', 2]])) === digestCanonical(obj([['a', 2], ['b', 1]]));
```

## 交叉测试

`src/encoder.ts`（迭代式、显式工作栈）与 `src/recursive-encoder.ts`（独立编写、自包含、递归）
互不共享实现。`test/cross.test.ts` 对固定语料 + 300 个确定性伪随机用例断言：

- 两个编码器输出逐字节一致；
- 由两者字节算出的摘要一致；
- 解析后再编码仍得到原规范字节（round-trip 稳定）。

## 运行测试

```sh
npm test    # = tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

需要 `tsc`（本仓库通过全局 TypeScript 7.0.2 编译；沙箱离线，`types/node-shim.d.ts`
提供了用到的 Node API 的最小环境声明，代替 `@types/node`）。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 执行 `npm test`：

```
> canonical-bytes@0.1.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

ok 1 - dist/test/cross.test.js
ok 2 - dist/test/digest.test.js
ok 3 - dist/test/encode.test.js
ok 4 - dist/test/parser.test.js
# tests 4
# pass 4
# fail 0
```

逐用例（spec reporter，共 32 个，全部通过）：

```
✔ cross-check fixed corpus covering every type and edge case
✔ cross-check deterministic pseudo-random corpus
✔ insertion order never changes bytes across both encoders
✔ digest is independent of object insertion order
✔ digest is independent of plain-object literal order
✔ digest equals sha256 of the canonical encoding
✔ known-answer digest for a fixed value
✔ different values produce different digests
✔ nested objects are canonicalized at every depth
✔ integer encoding uses zigzag varints
✔ bigint and number encode identically for the same integer
✔ rejects non-integer and unsafe numbers
✔ byte string encoding carries a length prefix
✔ array encoding concatenates elements in order
✔ object keys are sorted by UTF-8 byte order, not insertion order
✔ UTF-8 byte order differs from UTF-16 code unit order
✔ duplicate keys are rejected
✔ keys with unpaired surrogates are rejected
✔ Map and plain object inputs encode identically
✔ deeply nested values do not overflow the stack
✔ round-trips values of every type
✔ streaming: one byte at a time yields the value only when complete
✔ streaming: multiple values in one stream parse sequentially
✔ error offset: duplicate key reports the offset of the second key
✔ error offset: out-of-order keys are rejected at the misplaced key
✔ error offset: invalid UTF-8 in a key points at the key bytes
✔ error offset: non-minimal varint points at the redundant byte
✔ error offset: unknown tag points at the tag byte
✔ error offset: truncated input after end() points past the last byte
✔ error offsets stay absolute across chunk boundaries
✔ trailing bytes after a complete value are rejected
✔ surrogate halves encoded as (invalid) UTF-8 are rejected
```
