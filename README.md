# block-archive

按块独立压缩的归档库（TypeScript，仅依赖 Node.js 内置模块）。

- 输入按固定大小切块，每块用 `zlib.deflateRawSync` 独立压缩（无跨块字典，块间互不影响）。
- 索引记录每块的**原始长度**与 **CRC32**（`zlib.crc32`），索引本身也有 CRC32 校验。
- 范围读取 `readRange(offset, length)` 可跨块，但**只解压命中的块**。
- 坏块（解压失败 / 长度或 CRC 与索引不符）抛出 `CorruptBlockError`，携带该块的**原始字节区间** `[originalStart, originalEnd)`。
- 索引或包体被截断时 `parseArchive` 抛出 `TruncatedArchiveError`，绝不返回伪完整数据。

## 归档格式（小端）

```
头部（32 字节）
  0   4B  magic "BZAR"
  4   u16 版本 = 1
  6   u16 头部长度 = 32
  8   u32 块大小 blockSize
  12  u64 原始总长度
  20  u32 块数量
  24  u32 索引长度 = 块数量 × 12
  28  u32 索引 CRC32
索引（每块 12 字节 × N）
  +0  u32 原始长度
  +4  u32 压缩后长度
  +8  u32 原始数据 CRC32
包体
  各块 deflate-raw 压缩数据顺序拼接
```

解析时校验：magic、版本、索引长度与块数一致、索引 CRC32、各块原始长度之和等于头部总长度、包体长度等于各块压缩长度之和（少则截断、多则报错）。

## API

```ts
import { compressArchive, parseArchive } from "./src/archive.js";

const packed = compressArchive(data, { blockSize: 64 * 1024, level: 6 });
const archive = parseArchive(packed);   // 截断/篡改在此抛错
archive.originalSize;                   // 原始总长度
archive.blocks;                         // 每块的偏移/长度/CRC32
archive.readAll();                      // 全部解压
archive.readRange(offset, length);      // 只解压命中块后切片返回
```

错误类型：`ArchiveFormatError`（格式/校验失败）、`TruncatedArchiveError extends ArchiveFormatError`（截断）、`CorruptBlockError`（坏块，含 `blockIndex` / `originalStart` / `originalEnd`）。

## 测试

```sh
npm test        # 构建（剥离 TS 类型到 dist/）并用 node:test 运行
npm run typecheck   # 可选：需自行安装 typescript 与 @types/node
```

构建脚本 `scripts/build.mjs` 使用系统自带的 `@babel/core` + `@babel/preset-typescript` 做类型剥离（本环境 Node 未编译 TS 支持且无网络安装 tsc；源码仅用可擦除语法，等价于 tsc 转译）。

## 实际测试结果（Node v22.22.1）

`npm test` 输出（15 个测试全部通过）：

```
ok 1 - round-trip: readAll returns the original bytes for many sizes
ok 2 - round-trip: compressible text with default block size
ok 3 - index records original length and CRC32 of every block
ok 4 - blocks are independently compressed (no shared dictionary)
ok 5 - all small ranges match the original byte slices
# checked 231297 ranges against original slices
ok 6 - every possible range of a small archive matches the original
# checked 20301 ranges against original slices
ok 7 - range reads only decompress the hit blocks
ok 8 - corrupt block error reports the original byte range
ok 9 - every truncation point of index and body is rejected, never partial data
# all 842 truncation points rejected
ok 10 - index corruption is detected via CRC32
ok 11 - header corruption is detected
ok 12 - trailing garbage after the body is rejected
ok 13 - readRange validates its bounds
ok 14 - empty input produces a valid empty archive
ok 15 - accepts Uint8Array input and compression level option
# tests 15
# pass 15
# fail 0
```

要点：

- 测试 5：1024 字节、块长 128，穷举全部偏移 × 长度 0..257 共 **231297** 个小范围，逐一与原字节切片比对。
- 测试 6：200 字节、块长 7（刻意不对齐），穷举**全部** 20301 个范围。
- 测试 7：篡改块 #5 后，不触及该块的范围读取仍返回正确数据（证明只解压命中块），触及则抛 `CorruptBlockError`。
- 测试 9：对归档的**全部 842 个截断点**逐一验证，`parseArchive` 均抛 `TruncatedArchiveError`，无伪完整数据。
