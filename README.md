# layered-resource-resolver

按层优先级读取资源路径的解析库。TypeScript 编写，仅使用 Node.js 内置库
（`node:test` / `node:assert`），无任何运行时依赖。

## 语义

- **层优先级**：`new OverlayResolver(layers)` 中 `layers[0]` 优先级最高，
  逐层向下回退；高层条目遮蔽低层同名条目。
- **目录墓碑**：`layer.deleteDir(p)` 在层内写入目录墓碑，遮蔽低层 `p/` 下
  的整个子树；`deleteFile(p)` 只遮蔽低层同名文件。
- **当前层新建子项仍可见**：目录墓碑之后，在同一层 `writeFile`/`mkdir`
  重建的条目仍然可见；墓碑转化为"不透明目录"（opaque dir），对低层的
  遮蔽屏障保持不变。
- **大小写规则由输入指定**：`new OverlayResolver(layers, { caseSensitive })`
  统一决定所有路径比较；大小写不敏感时比较做小写折叠，但列目录保留条目
  原始显示名（以最高优先级提供者的拼写为准）。`MemoryLayer` 的大小写规则
  与解析器不一致会直接抛错。
- **列目录与读文件一致**：`listDir` 与 `readFile`/`stat` 走同一套逐层
  屏障判定；子级墓碑只遮蔽更低层，不删除高层已合并的条目，因此
  "列出的必可读、可读的必被列出"（有测试双向核对）。
- **不可变快照**：`resolver.snapshot()` 返回冻结副本，之后对活层的增删
  不影响快照；快照层上的写操作抛错。
- **逐层扫描核对**：`resolver.scan(path)` 返回每一层的判定轨迹
  （`hit-file` / `hit-dir` / `hit-opaque-dir` / `tombstone-file` /
  `tombstone-dir` / `blocked-by-dir-tombstone` / `miss`），用于核对
  混合墓碑场景。

## 用法

```ts
import { MemoryLayer, OverlayResolver } from './src/index.js';

const base = new MemoryLayer('base');
base.writeFile('/assets/img/logo.png', 'v1');
const patch = new MemoryLayer('patch');
patch.deleteDir('/assets/img');            // 遮蔽 base 的整个子树
patch.writeFile('/assets/img/new.png', 'v2'); // 本层新建，仍可见

const r = new OverlayResolver([patch, base], { caseSensitive: true });
r.readTextFile('/assets/img/new.png');  // 'v2'
r.readFile('/assets/img/logo.png');     // undefined（被墓碑遮蔽）
r.listDir('/assets/img');               // ['new.png']
r.scan('/assets/img/logo.png').trace;   // 逐层判定轨迹

const snap = r.snapshot();               // 不可变快照
```

## 测试

```sh
npm test    # tsc 编译 + node --test 运行
```

实际运行结果（Node v22.22.1，tsc 7.0.2，2026-10-05）：

```
$ npm test
> tsc -p tsconfig.json && node --test dist/test/resolver.test.js
ok 1 - dist/test/resolver.test.js
# tests 1
# pass 1
# fail 0
# duration_ms 559.137566
```

展开套件明细（`node dist/test/resolver.test.js`）：

```
ok 1 - layer priority
ok 2 - directory tombstones
ok 3 - file tombstones and priority
ok 4 - case rules
ok 5 - list/read consistency
ok 6 - immutable snapshots
ok 7 - layer-by-layer scan of mixed tombstones
# tests 15
# suites 7
# pass 15
# fail 0
```

15 个用例全部通过，退出码 0。

## 结构

- `src/path.ts` — 路径规范化、祖先枚举等纯函数
- `src/layer.ts` — `Layer` 接口与 `MemoryLayer`（文件/目录/墓碑条目、
  不透明目录、冻结快照）
- `src/resolver.ts` — `OverlayResolver`（逐层解析、目录合并、扫描轨迹、快照）
- `test/resolver.test.ts` — 7 个套件 15 个用例
- `types/node.d.ts` — 离线环境下 `node:test` 等内置模块的最小类型声明
