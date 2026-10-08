# anchor-patch

内容锚定的补丁库（TypeScript，仅依赖 Node.js 内置模块）。

## 语义

- **输入**：基线（可选，仅作为 `hint` 来源）、目标文本、补丁列表。每个补丁
  携带修改区间的**原始内容** `old` 与替换内容 `new`。
- **定位**：在目标文本中按原始内容搜索定位，因此目标已相对基线漂移（前置
  内容被改、偏移移动）时仍能正确定位。`hint`（基线偏移）只作为证据记录，
  绝不用于消歧。
- **歧义不猜**：`old` 有多个匹配时报 `ambiguous` 并枚举全部候选偏移与上下文
  摘录；零匹配报 `not-found`；只有唯一匹配才应用。
- **小字符串枚举核对**：`old.length <= 8`（`SMALL_STRING_THRESHOLD`）时证据中
  标记 `smallString: true`；所有出现位置（含重叠出现）都会被枚举并附上下文
  摘录（`>>>match<<<`），供人工核对。
- **原子应用**：先对全部补丁做定位校验，并检查定位区间互不重叠；任一失败则
  整体不应用，返回错误与完整证据。
- **输出**：成功时返回 `output`、**逆补丁** `inverse`（输出坐标系，含
  `offset/old/new`，`revert()` 可精确还原目标文本）与每个补丁的**定位证据**
  `evidence`。

## API

```ts
import { applyPatches, revert, locate, enumerateOccurrences } from "anchor-patch";

const result = applyPatches(target, [
  { id: "p1", old: "epsilon", new: "EPSILON", hint: 23 },
]);
if (result.ok) {
  console.log(result.output);    // 补丁后文本
  console.log(result.inverse);   // 逆补丁（输出坐标）
  console.log(result.evidence);  // 定位证据
  revert(result.output, result.inverse); // 还原 target
} else {
  console.error(result.errors);  // 歧义 / 未找到 / 重叠，未应用任何补丁
}
```

## 构建与测试

```sh
npm test   # tsc 类型检查并编译，然后运行 node:test 测试
```

需要全局可用的 `tsc`（本仓库无 npm 依赖；`types/node-shim.d.ts` 自带
`node:test` / `node:assert` 的最小类型声明）。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），2026-10-08。

```
$ npm test
> tsc -p tsconfig.json && node --test 'dist/test/*.test.js'
ok 1 - dist/test/patch.test.js
# tests 1
# pass 1
# fail 0
```

文件内 16 个用例（3 个 describe + 13 个 test）全部通过：

```
ok - unique match reports chosenOffset and evidence
ok - multiple matches are ambiguous, never guessed, all enumerated
ok - missing content is not-found
ok - hint is evidence only and does not disambiguate
ok - small strings are flagged and occurrences enumerated with overlap
ok - finds overlapping occurrences
ok - empty needle yields nothing
ok - applies a single patch and emits inverse + evidence
ok - locates by original content when the target already drifted
ok - ambiguity in any patch fails the whole batch atomically
ok - not-found fails atomically even when other patches are valid
ok - applies multiple patches atomically with shifted inverse offsets
ok - overlapping located ranges are rejected
ok - empty old is rejected
ok - small repeated string: ambiguity evidence enumerates every candidate
ok - adding context to old resolves a repeated small string
```
