# layered-resolver

分层资源解析库：按层优先级读取路径，支持目录墓碑、可配置大小写规则、
目录列举与读文件一致的合并视图，以及不可变快照。仅使用 TypeScript 与
Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 语义

- **层优先级**：`layers[0]` 为最高优先级（顶层，可写）。解析路径时自上而下
  扫描，同一路径取最高层的条目。
- **目录墓碑**：在某层 `remove()` 一个目录会写入墓碑，遮蔽该路径及其在下层
  的整个子树（墓碑、文件、重建的 opaque 目录都会遮蔽下层子树）。
- **当前层新建子项仍可见**：墓碑只遮蔽优先级更低的层；同层在墓碑之后新建的
  子项（`remove('/a/b')` 后再 `writeFile('/a/b/new.txt')`）依然可见，父目录
  自动重建为 opaque 目录。
- **大小写规则由输入指定**：`new LayeredResolver({ caseSensitive: false })`
  时查找与列举去重均按大小写折叠，但保留首次（最高层）写入的显示名。
- **列目录与读文件一致**：`readdir()` 与 `readFile()`/`stat()` 共用同一套
  可见性规则——列出的名字一定能 `stat`，可读的文件一定会被列出。
- **不可变快照**：`snapshot()` 逐层克隆并冻结；之后对原解析器或其层的任何
  修改都不影响快照，对快照的写操作抛出 `EFROZEN`。

## API 摘要

```ts
import { LayeredResolver } from 'layered-resolver';

const resolver = new LayeredResolver({ caseSensitive: false });
const top = resolver.addLayer('top');    // 最高优先级，接收写入
const base = resolver.addLayer('base');  // 下层

base.writeFile('/app/config.json', '{"v":1}');
resolver.readFile('/APP/CONFIG.JSON');   // => '{"v":1}'
resolver.readdir('/app');                // => ['config.json']
resolver.remove('/app/config.json');     // 在顶层写墓碑
const snap = resolver.snapshot();        // 不可变快照
```

## 测试

```
npm test    # tsc 构建后用 node:test 运行 dist/test/*.test.js
```

测试包含一个独立的“逐层扫描”参考实现（`test/scan-crosscheck.test.ts`）：
它自上而下逐层扫描、维护被遮蔽前缀集合，独立算出合并视图，再与解析器通过
`readdir`/`readFile` 走查得到的实际视图做深度比较；用手工混合墓碑夹具与
确定性随机操作序列（大小写敏感/不敏感各 300 步，含快照漂移检查）核对。

### 实际运行结果（Node.js v22.22.1，2026-10-05）

```
# Subtest: layer priority
ok 1 - layer priority
# Subtest: directory tombstones
ok 2 - directory tombstones
# Subtest: case rules specified by input
ok 3 - case rules specified by input
# Subtest: readdir/readFile consistency
ok 4 - readdir/readFile consistency
# Subtest: immutable snapshots
ok 5 - immutable snapshots
# Subtest: layer-by-layer scan cross-check with mixed tombstones
ok 6 - layer-by-layer scan cross-check with mixed tombstones
# tests 18
# suites 6
# pass 18
# fail 0
```

注：测试脚本使用 `--experimental-test-isolation=none`，因为本环境沙箱禁止
派生子进程；该选项在普通机器上同样可用（Node.js >= 22.8）。
