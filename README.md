# resumable-importer

可断点续传的文件导入库（TypeScript + Node.js 内置库，零运行时依赖）。
源文件按换行分隔为 UTF-8 记录，按记录批次把**字节偏移与前缀摘要**持久化为检查点。

## 检查点格式

```json
{
  "version": 1,
  "offset": 128,          // 已消费的源文件字节数
  "pending": "5Lit",      // 未完结半条记录的原始字节（base64）
  "records": 5,           // 已导入记录总数
  "digest": "…"           // 源文件前缀 [0, offset) 的 SHA-256
}
```

## 恢复语义

恢复时**先核对源文件**，再决定是否继续：

- 文件短于 `offset`（被截断）→ 抛出 `SourceModifiedError`；
- 前缀 `[0, offset)` 的 SHA-256 与摘要不符（中段修改）→ 抛出 `SourceModifiedError`，拒绝继续；
- 前缀一致且文件变长（源尾追加）→ 从 `offset` 继续导入，旧记录不重复；
- 前缀一致且长度不变 → 直接完成。

偏移之后尚未读取的字节对导入器而言属于“尾部数据”，其变化视同追加。

## 多字节编码跨检查点

暂停可能发生在任意字节（包括多字节 UTF-8 字符中间）。未遇到换行符的
半条记录以**原始字节**存入检查点 `pending`，恢复后拼回继续扫描，仅在记录
完结（遇到 `\n`）时才解码为字符串并计数，因此每条记录恰好导入一次，
跨检查点的多字节字符不会重复记录也不会残缺。

## 用法

```ts
import { importFile } from './src/importer.js';

const result = importFile({
  source: 'data.txt',
  checkpoint: 'data.checkpoint.json',
  batchSize: 16,          // 每 16 条记录保存一次检查点
  byteBudget: 1024,       // 可选：本次最多消费的字节数（用于暂停）
  sink: (record, index) => console.log(index, record),
});
// result.status === 'paused' 时再次调用即可从检查点恢复
```

## 测试

```sh
npm test   # 编译 TypeScript 后用 node:test 运行 dist/test/*.test.js
```

环境：Node.js v22.22.1，TypeScript 7.0.2（全局安装，`tsc` 不在 PATH 时
`npm run build` 回退到 `/usr/local/lib/node_modules/typescript/bin/tsc`）。
本环境无法安装 `@types/node`，`types/node-shim.d.ts` 提供所用内置 API 的最小类型声明。

### 实际测试结果（2026-10-05）

```
ok 1 - 完整导入：按记录批次保存字节偏移与前缀摘要
ok 2 - 逐字节暂停与恢复：多字节字符跨检查点不重复记录
ok 3 - 源尾追加可继续：旧记录不重复，新记录按序导入
ok 4 - 中段修改必须拒绝：同长度篡改、整文件替换、截断
ok 5 - 篡改检查点之后、追加新行仍可继续（视为源尾数据）
# tests 5
# pass 5
# fail 0
```

其中测试 2 以 `byteBudget: 1` 逐字节暂停/恢复整个文件（68 字节、68 次运行），
断言期间确实出现过检查点落在多字节字符中间（`pending` 以不完整的 UTF-8
序列结尾），最终记录与预期完全一致、无重复。
