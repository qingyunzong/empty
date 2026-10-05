# config-loader

TypeScript 配置加载库：输入全部来自**虚拟文件表**（内存中的 `路径 -> 内容` 映射），
支持相对 `include`、覆盖、数组追加、按当前递归栈判环，并为每个最终字段记录来源链；
所有错误都携带完整包含路径。仅使用 Node.js 内置模块，零运行时依赖。

## 用法

```ts
import { loadConfig } from './src/loader.js';

const { config, provenance } = loadConfig('app.json', {
  'app.json':  JSON.stringify({ include: 'base.json', server: { port: 8080 } }),
  'base.json': JSON.stringify({ server: { host: 'localhost', port: 80 } }),
});

// config.server            => { host: 'localhost', port: 8080 }
// provenance 'server.port' => ['base.json', 'app.json']   （覆盖链）
// provenance 'server.host' => ['base.json']
```

虚拟文件表可以是 `Record<string, string>` 或 `Map<string, string>`。

## 语义

- **配置文件**：JSON 对象；特殊键 `include` 为字符串或字符串数组。
- **相对 include**：相对于包含它的文件所在目录解析，支持 `./`、`../` 归一化。
- **合并顺序**：先按顺序合并各 include，再应用本文件自身的键。
- **覆盖**：标量后者覆盖前者；对象递归深合并。
- **数组追加**：同名数组跨文件拼接（`[1] + [2] => [1, 2]`）。
- **判环**：只在**当前递归栈**上检测循环。菱形引用（A→B、A→C、B→D、C→D）
  合法，D 的效果按包含次数生效（数组会追加两次，来源链中也会出现两次）。
- **来源链（provenance）**：`Map<点路径, 文件链>`，按贡献顺序记录每个最终字段
  的来源文件；被覆盖的标量保留完整覆盖历史，被整体替换的子树会清理失效条目。
- **错误**：`ConfigError` 的 `message` 与 `includePath` 均携带从入口到失败点的
  完整链，例如 `app.json -> sub/b.json -> missing.json`。

## 测试

```sh
npm test    # tsc 编译到 dist/ 后用 node --test 运行
```

前提：环境中有 `tsc`（TypeScript 编译器）；运行时为 Node.js，无需安装任何 npm 依赖。

### 实际运行结果（Node v22.22.1，tsc 7.0.2）

```
ok 1 - basic loading
ok 2 - relative includes
ok 3 - override semantics and provenance
ok 4 - array append
ok 5 - diamond includes
ok 6 - cycle detection (current recursion stack only)
ok 7 - error reporting with full include path
# tests 18
# suites 7
# pass 18
# fail 0
```

18 个测试全部通过，覆盖：单文件加载、相对路径与 `..` 归一化、覆盖后溯源
（`server.port => ['base.json', 'app.json']`）、数组追加、菱形引用
（`tags => ['d','b','d','c','a']`，来源链同步记录重复贡献）、
直接环/自包含环检测、缺失文件与非法 JSON 的完整包含路径报错。

## 文件结构

- `src/loader.ts` — 库实现（`ConfigLoader` / `loadConfig` / `ConfigError`）
- `test/loader.test.ts` — `node:test` 测试
- `types/node-shims.d.ts` — 最小 Node 内置模块类型声明（离线环境替代 `@types/node`）
