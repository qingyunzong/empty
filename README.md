# secret-scan

按**有限字节模式**扫描秘密串的 TypeScript 库，支持上下文白名单、任意切块流式扫描、
原偏移报告与遮盖预览。仅使用 Node.js 内置库（`Buffer`、`node:test`），零运行时依赖。

## 设计

- **有限字节模式**：每个模式（`BytePattern`）必须声明 `maxLength`（匹配字节长度上界）。
  运行时发现更长的匹配会立即抛错，保证"有限"假设成立。
- **块边界不漏**：流式扫描器在块间保留 `maxSecretLength + maxWhitelistLength` 字节。
  只有当某个匹配的完整可能范围（`start + maxLength`）都落在已见窗口内时才定案，
  因此跨块匹配不会漏报、截断或重复；每个模式按 leftmost-resume 语义独立推进，
  与整串扫描逐一对应。
- **白名单仅遮盖完整包含范围**：匹配只有被某个白名单区间**完整包含**时才被抑制
  （`suppressed: true`）；部分重叠不抑制。白名单区间跨块同样有效。
- **重叠模式归并**：不同模式产生的重叠匹配归并为一条 `Finding`，
  `patterns` 列出所有贡献模式；仅相接（不重叠）的匹配不归并。
- **原偏移与遮盖预览**：所有偏移都是原始输入的字节偏移（输入按 latin1 字节串处理，
  1 字节 = 1 码元）。`maskPreview` 将未抑制的发现等长替换为 `*`，
  被白名单抑制的部分保持可见。

已知限制：模式应是"局部"的——`^`/`$` 锚点（未配合 `m` 标志）与可变长后行断言
依赖窗口边界，不在等价保证范围内。

## 用法

```ts
import { SecretScanner, scan, maskPreview, formatReport } from "secret-scan";

const secrets = [
  { name: "aws-key", regex: /AKIA[0-9A-Z]{16}/, maxLength: 20 },
];
const whitelist = [
  { name: "example-box", regex: /EXAMPLE\[[^\]\n]{1,64}\]/, maxLength: 73 },
];

// 一次性扫描
const findings = scan(text, secrets, whitelist);
console.log(formatReport(findings));
console.log(maskPreview(text, findings));

// 任意切块流式扫描（结果与整串扫描一致）
const scanner = new SecretScanner(secrets, whitelist);
for (const chunk of chunks) scanner.push(chunk);
const streamed = scanner.finish();
```

## 构建与测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

环境说明：本仓库自带 `types/node-shim.d.ts`（仅声明用到的 Node 内置 API），
无需安装 `@types/node`。

## 测试结果（实际记录）

在 Node.js v22.22.1、TypeScript 7.0.2 下执行 `npm test` 的实际输出：

```text
✔ whole-input scan reports original byte offsets (15.420835ms)
✔ chunked scan equals whole-input scan for fixed chunk sizes (27.330297ms)
✔ chunked scan equals whole-input scan for 200 random chunkings (65.136113ms)
✔ match spanning a chunk boundary is not missed (1.320359ms)
✔ whitelist suppresses only fully contained ranges (0.881253ms)
✔ whitelist span crossing chunks still suppresses a boundary match (3.058336ms)
✔ overlapping pattern matches are merged into one finding (1.384227ms)
✔ adjacent but non-overlapping matches are not merged (0.911329ms)
✔ masked preview hides active findings and keeps whitelisted ones (1.601259ms)
✔ report lists original offsets and suppression status (2.296947ms)
✔ match longer than the declared maxLength throws (1.949002ms)
✔ empty input yields no findings (0.433821ms)
✔ push after finish throws (0.399958ms)
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

其中"任意切块与整串扫描对照"覆盖：固定块大小 1/2/3/5/7/13/64/4096，
以及 200 组随机切块（块长 1–97，字符串/Buffer 混合喂入），
逐项比对归并后的 `Finding[]`、原始 `RawMatch[]` 序列与遮盖预览，全部一致。
