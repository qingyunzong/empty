# module-loader

一个 TypeScript 编写的模块加载库，仅依赖 Node.js 内置模块
（`node:async_hooks`，测试使用 `node:test` / `node:assert`），无任何 npm 运行时依赖。

## 特性

- **合并同 ID 请求**：同一模块 ID 的并发请求共享同一个进行中的加载
  Promise，源只获取一次，所有请求方拿到同一份导出对象。
- **跟踪当前加载依赖链**：通过 `AsyncLocalStorage` 在每个异步上下文中
  记录当前加载链，并把已请求的依赖边记入依赖图。
- **成环时给出最短字典序环**：当新依赖边 `parent -> id` 会闭合成环时
  （`id` 经已记录的依赖边可达 `parent`），立即以 `CycleError` 快速失败。
  报告的环是穿过该闭合边的**最短环**（BFS 最短路 + 字典序 tie-break），
  并旋转到字典序最小的模块开头，例如 `a -> b -> c -> a`，与入口模块无关。
- **共享请求不互等**：共享请求直接并入进行中的加载；只有真正成环的
  请求才失败。两个并发入口相互依赖时（`m <-> n`），等待图上先闭合的
  一边会检测到环并拒绝，两边都快速失败而不是互相等待死锁。
- **失败只清除该代缓存**：每次最外层 `load` 构成一个"代"（generation），
  代内创建的缓存项都盖上该代戳。加载失败时仅驱逐该代的缓存项与依赖边，
  老一代已成功加载的模块保持缓存，重试时不会重新获取。

## 结构

- `src/module-loader.ts` — 核心库：`ModuleLoader`、`CycleError`、`Loader` 类型。
- `src/controllable-loader.ts` — 可控加载器：定义模块、统计获取次数、
  用 `gate`/`release` 卡住单次获取、用 `failNext` 注入失败、
  用 `whenCalled` 等待调用发生。
- `test/` — 基于 `node:test` 的测试：
  - `test/diamond.test.ts` — 菱形共享（`a -> b,c -> d`，`d` 只获取一次）
    与同 ID 并发请求合并。
  - `test/cycle.test.ts` — 环的规范化报告（与入口无关）、自依赖、
    最短环、等长环字典序、并发互依入口不死锁。
  - `test/retry.test.ts` — 失败后重试、失败只清该代缓存（老代保留）、
    环拒绝后修复图可重新加载。
- `types/node.d.ts` — 所用 Node 内置模块的最小类型声明（代替 @types/node）。

## 使用

```ts
import { ModuleLoader } from './src/module-loader.js';

const modules = new ModuleLoader(async (id) => ({
  dependencies: ['b'],
  exports: { id },
}));

const exportsOfA = await modules.load('a');
```

## 测试

需要 Node.js（>= 18）与 TypeScript 编译器（本仓库用 `typescript@7.0.2`，
`npm i -D typescript` 亦可）。`npm test` 先用 `tsc` 编译到 `dist/`，
再用 Node 内置测试运行器执行：

```sh
npm test
```

## 实际测试结果

以下为本仓库在 Node.js v22.22.1 + TypeScript 7.0.2 下的真实运行输出
（连续运行 5 次结果一致）：

```text
$ npm test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/cycle.test.js
ok 1 - dist/test/cycle.test.js
# Subtest: dist/test/diamond.test.js
ok 2 - dist/test/diamond.test.js
# Subtest: dist/test/retry.test.js
ok 3 - dist/test/retry.test.js
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

逐用例（共 10 个，全部通过）：

```text
ok 1 - cycle is reported canonically regardless of the entry module
ok 2 - a module depending on itself forms a one-node cycle
ok 3 - the shortest cycle through the closing edge is reported
ok 4 - equal-length cycles are tie-broken lexicographically
ok 5 - mutually dependent concurrent roots reject instead of waiting on each other
ok 1 - diamond: a shared dependency is fetched once and shared by all dependents
ok 2 - concurrent same-ID requests share a single in-flight load
ok 1 - a failed load evicts its generation so a retry re-fetches and succeeds
ok 2 - a failure clears only its own generation, older generations stay cached
ok 3 - after a cycle rejection the generation is cleared and a fixed graph loads
```
