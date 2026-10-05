# atomic-export

快照导出库：导出开始即固定数据快照，最终发布前重新核验全部涉及行的权限代，
任何撤销使全文件不发布；中间暂存不可读；发布为原子替换。零运行时依赖
（仅 Node.js 内置库），TypeScript 编写。

## 导出流程（`src/exporter.ts`）

1. `dataSource.snapshot()` —— 导出开始时固定数据快照（含每行的权限代）。
2. `renderExport()` —— 确定性渲染为按行 id 排序的 JSON Lines。
3. `storage.writeStaging()` —— 写入中间暂存；暂存文件以 `0o000` 创建，
   任何进程（含属主）在发布前都无法打开读取。
4. 发布前逐行调用 `permissions.getPermissionGeneration(id)` 复核**全部**
   涉及行的权限代（不短路，收集所有撤销行）。
5. 任何一行权限代变化或行消失 → 抛出 `PermissionRevokedError`，丢弃暂存，
   **全文件不发布，旧文件不变**。
6. 全部一致 → `storage.publish()`：`chmod` 最终权限 + `rename` 原子替换 +
   目录 fsync。发布失败同样丢弃暂存，旧文件不变。

## 可注入适配器（`src/types.ts`）

- `DataSourceAdapter` —— 数据来源；`src/memory.ts` 提供内存实现。
- `PermissionAdapter` —— 权限代查询；内存实现的 `revoke()` 模拟撤销。
- `StorageAdapter` —— 暂存/发布/丢弃；`src/fileStorage.ts` 为文件系统实现。

测试中通过装饰器注入故障：`RevokingStorage`（暂存写入期间撤销权限，模拟
导出进行中的权限变化）、`FailingPublishStorage`（publish 抛错，模拟发布
失败），并断言旧文件字节不变、无暂存残留。

## 运行

```sh
npm test   # tsc 编译 + node --test（需要系统可用的 tsc，仅开发期使用）
```

## 测试结果（实际运行记录）

环境：Node.js v22.22.1，tsc 7.0.2，Linux。

`npm test`：

```
# Subtest: dist/test/exporter.test.js
ok 1 - dist/test/exporter.test.js
# Subtest: dist/test/fileStorage.test.js
ok 2 - dist/test/fileStorage.test.js
# tests 2
# pass 2
# fail 0
```

各用例明细（直接运行编译产物）：

```
ok 1 - 全部权限代一致时原子发布，内容来自固定快照
ok 2 - 发布前任何权限撤销使全文件不发布，旧文件不变，暂存清理
ok 3 - 复核不短路：多个撤销行全部收集
ok 4 - 发布失败时旧文件不变，暂存清理
ok 5 - 导出期间源数据被修改，发布内容仍为开始时的固定快照
ok 1 - 中间暂存不可读：权限位 0o000，发布前无法读取
ok 2 - discard 删除暂存，目标路径从不出现
ok 3 - publish 原子替换已存在的旧文件
# tests 8  # pass 8  # fail 0
```
