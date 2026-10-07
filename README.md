# param-merge

分层参数解析库（TypeScript，零依赖）：合并 **默认值 < 配置文件 < 命令行** 三层参数，
并为每个最终值记录来源（layer + 位置），互斥组基于最终合并值核验。

## 合并规则

- **单值选项**：最高层生效；同层内多次出现时末次生效。
- **列表选项**：同层内出现次数累加；更高层一旦出现即整体替换低层列表（不跨层累加）。
- **`--`**：终止选项解析，其后所有 token 作为 positionals 返回。
- **互斥组**：在最终合并值上核验；最终值来自 config 或 cli（即显式设置，非默认）
  的成员超过一个即报错，错误信息列出每个成员的来源与位置。
- **错误定位**：所有错误（未知选项、缺值、类型错误、互斥冲突）均携带
  `{ layer, position }`，位置形如 `argv[3]` / `config.format` / `default`。

## 用法

```ts
import { resolve } from "./src/params.js";

const result = resolve({
  specs: [
    { name: "format", short: "f", type: "string", default: "text" },
    { name: "include", short: "I", type: "list", default: ["base"] },
    { name: "json", type: "boolean" },
    { name: "yaml", type: "boolean" },
  ],
  config: { format: "json", include: ["a", "b"] },
  argv: ["--include", "c", "--yaml", "--", "file.txt"],
  mutexGroups: [["json", "yaml"]],
});
// result.values     => { format: "json", include: ["c"], yaml: true }
// result.sources    => { format: {layer:"config",position:"config.format"}, ... }
// result.positionals => ["file.txt"]
// result.errors     => []
```

## 脚本

- `npm test`：先 `tsc` 编译到 `dist/`，再用 `node --test` 运行全部测试。
- `npm run build`：仅编译。

测试为表驱动：`test/params.test.ts` 中的 `mergeCases` / `mutexCases` /
`errorCases` 三张表覆盖 默认值×配置×命令行 的组合、互斥核验与错误定位。
