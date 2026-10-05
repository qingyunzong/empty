# safe-export

快照式安全导出库（TypeScript，仅依赖 Node.js 内置模块，零 npm 依赖）。

## 保证

1. **开始即固定快照**：`Exporter.export()` 首先调用 `SnapshotSource.beginSnapshot()`，
   之后数据源的任何变更都不会进入本次导出内容。
2. **发布前重新核验权限代**：暂存完成后、发布之前，对快照中**全部涉及行**逐行调用
   `PermissionAuthority.currentEpoch()`。任何一行被撤销（返回 `null`）或权限代与快照
   不一致，整个文件不予发布（抛出 `PermissionVerificationError`）。
3. **中间暂存不可读**：暂存目录权限 `0700`、暂存文件权限 `0600`，仅属主可读写。
4. **全有或全无发布**：发布通过同目录原子 `rename` 完成；核验失败或发布失败都会清理
   暂存，已存在的旧目标文件保持字节级不变。

## 适配器（全部可注入）

| 接口 | 职责 | 内置实现 |
| --- | --- | --- |
| `SnapshotSource` | 导出开始时固定数据快照 | `MemorySnapshotSource` |
| `PermissionAuthority` | 发布前提供每行当前权限代（`null` = 已撤销） | `MemoryPermissionAuthority` |
| `Publisher` | 暂存（不可读）+ 原子提交/中止 | `FsPublisher` |

测试通过包装/替换这些适配器来模拟：导出中途撤销权限、权限代变化、发布失败，
并断言旧文件不变、暂存被清理。

## 用法

```ts
import { Exporter, FsPublisher, MemorySnapshotSource, MemoryPermissionAuthority } from "./src/index";

const exporter = new Exporter(
  new MemorySnapshotSource(rows),          // 快照源
  new MemoryPermissionAuthority(epochs),   // 权限权威
  new FsPublisher()                        // 文件系统发布器（暂存于目标旁 .staging/）
);

const result = await exporter.export({ targetPath: "/data/export.ndjson" });
// 任一涉及行被撤销或权限代变化 => 抛 PermissionVerificationError，文件不发布
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test（Node 内置测试运行器）
```

实际测试结果见 [TEST_RESULTS.md](./TEST_RESULTS.md)。

## 环境说明

- 运行环境 Node.js v22，全局 TypeScript 7（`tsc`）；本环境 Node 构建未启用
  `--experimental-strip-types`，因此 `npm test` 先编译再运行。
- 环境无网络，无法安装 `@types/node`；`types/node-shim.d.ts` 提供了本项目用到的
  Node 内置模块的最小类型声明。
