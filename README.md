# checkpoint-importer

按记录批次导入文本文件（每行一条记录）的 TypeScript 库，只依赖 Node.js 内置模块。
每处理完一批记录就把 **字节偏移 + 前缀摘要（SHA-256）** 原子地写入检查点文件，
支持安全断点续传。

## 设计

- **检查点内容**（`src/importer.ts` 中的 `Checkpoint`）：
  - `offset`：已消费的字节偏移，始终落在记录边界（`0x0A` 之后）；
  - `records`：已导入的记录总数；
  - `digest`：源文件 `[0, offset)` 字节的 SHA-256（前缀摘要）。
- **恢复时先核对源文件**：
  - 文件长度 < `offset` → 拒绝（被截断或替换）；
  - 重算 `[0, offset)` 的摘要，与检查点不一致 → 抛出 `SourceModifiedError`
    （中段修改必须拒绝）；
  - 仅尾部追加（前缀逐字节一致、文件变长）→ 从 `offset` 处继续导入。
- **多字节编码安全**：记录按字节切分，换行符 `0x0A` 不会出现在 UTF-8 多字节
  序列内部，因此检查点永远不会劈开字符；跨块/跨检查点的残缺字节会留在
  `pending` 缓冲区里等后续数据，恢复时从精确字节偏移继续，任何记录都不会
  被重复记录。
- **不完整尾行**：文件末尾没有换行符的半截记录不消费、不计入检查点，
  等换行符到达后再导入。
- 检查点通过「写临时文件 + rename」原子落盘；`onBatch` 成功后才持久化，
  崩溃重跑时同一批最多重放一次（at-least-once）。

## 用法

```ts
import { importFile } from './src/importer.js';

const result = importFile('data.txt', {
  checkpointPath: 'data.checkpoint.json',
  batchSize: 100,          // 每批记录数
  maxBatches: 2,           // 可选：处理 N 批后暂停（用于断点续传）
  onBatch: (records, checkpoint) => {
    // 消费这一批记录；checkpoint 含 offset / records / digest
  },
});
// result: { records, batches, resumed, complete, checkpoint }
```

## 测试

```sh
npm test   # tsc 编译后运行 node:test 测试
```

环境：Node.js v22.22.1，TypeScript 7.0.2（全局安装；离线环境无法安装
`@types/node`，`types/node-shim.d.ts` 提供了用到的内置模块的最小类型声明）。

覆盖场景：分批保存偏移与摘要、暂停后续传不重复、源尾追加可继续、
中段修改拒绝、替换源文件拒绝、截断拒绝、**逐字节暂停**（每追加一个字节
就跑一次导入，验证多字节字符不被劈开或重复）、不完整尾行暂缓。

### 实际运行结果（2026-10-05）

```
$ npm test
> tsc -p tsconfig.json && node dist/test/importer.test.js

ok 1 - saves byte offset and prefix digest after every record batch
ok 2 - resume after pause continues without duplicating records
ok 3 - tail append to the source allows the import to continue
ok 4 - mid-file modification is rejected on resume
ok 5 - replacing the source file is rejected on resume
ok 6 - truncated source is rejected on resume
ok 7 - byte-by-byte pause: multi-byte characters are never split or double-recorded
ok 8 - incomplete trailing record is held back until its newline arrives
1..8
# tests 8
# pass 8
# fail 0
# duration_ms 91.822769
```

8 个测试全部通过，退出码 0。
