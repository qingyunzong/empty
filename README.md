# virtual-config-loader

TypeScript 配置加载库：输入全部来自内存中的虚拟文件表（路径 → 内容），不触碰真实文件系统，仅依赖 Node.js 内置模块。

## 功能

- **相对 include**：`"$include": "./base.json"`（或数组），相对路径相对于**当前包含文件**解析，支持 `./`、`../`、绝对虚拟路径。
- **覆盖**：后加载的内容覆盖先加载的（include 按顺序合并，文件本体最后合并）；对象深合并，标量与数组默认整体替换。
- **数组追加**：`"key+": [...]` 追加到此前装配出的数组上；追加意图会跨 include 边界传播。
- **环检测只在当前递归栈上进行**：菱形引用（A→B、A→C，B→D、C→D）合法，D 每个分支各加载一次；只有同一条包含链上回到自身才报错。
- **来源链**：每个最终字段（含数组每个元素）记录 `provenance[path]`，按应用顺序列出贡献文件，覆盖时旧来源保留在链中。
- **错误带完整包含路径**：`ConfigError.message` 与 `ConfigError.includeChain` 均包含从入口文件到出错文件的完整路径。

## API

```ts
import { loadConfig } from "./src/config-loader.js";

const { config, provenance } = loadConfig(
  {
    "app.json":  JSON.stringify({ $include: ["./base.json"], "plugins+": ["final"], db: { host: "prod" } }),
    "base.json": JSON.stringify({ plugins: ["a"], db: { host: "dev", port: 5432 } }),
  },
  "app.json",
);
// config      = { plugins: ["a", "final"], db: { host: "prod", port: 5432 } }
// provenance  = {
//   "plugins":   ["base.json", "app.json"],
//   "plugins.0": ["base.json"],
//   "plugins.1": ["app.json"],
//   "db.host":   ["base.json", "app.json"],   // 覆盖后仍可溯源
//   "db.port":   ["base.json"],
//   ...
// }
```

## 运行测试

```sh
npm test    # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - relative includes resolve against the including file
ok 2 - parent-directory includes (..) resolve correctly
ok 3 - scalar override wins and provenance records the full source chain
ok 4 - array override replaces by default
ok 5 - 'key+' appends arrays across files with per-element provenance
ok 6 - 'key+' on a missing field creates the array
ok 7 - diamond includes are allowed: shared file loads once per branch
ok 8 - diamond with override: later branch overrides, chain stays ordered
ok 9 - circular include throws with the full include path
ok 10 - self include is detected as a cycle
ok 11 - missing file error carries the full include path
ok 12 - invalid JSON error names the file and the include path
ok 13 - appending to a non-array field is an error with include path
ok 14 - deep objects merge across include levels
ok 15 - later includes override earlier includes
ok 16 - path utilities normalize and resolve virtual paths
# tests 16
# pass 16
# fail 0
```

## 结构

- `src/config-loader.ts` — 加载器实现（路径归一化、递归 include、合并、溯源）
- `test/config-loader.test.ts` — 16 个用例，含菱形引用、覆盖后溯源、环检测、错误包含路径
- `types/node-shims.d.ts` — `node:test` / `node:assert` 最小类型声明（环境无 `@types/node`）
