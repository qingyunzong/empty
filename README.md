# Oracle SCN 跨线程排序

日志挖掘入口需要可嵌入 C++ 事务排序组件，合并多个 redo thread 的 SCN、subSCN、事务 id 与 commit 标记。行变化先缓冲到事务，提交顺序相同则用公开并列键；thread reset 开启新世代。回滚和补偿记录必须撤销正确版本，水位不得越过未决事务。

## 组件

`dataeng::TxnMerger`(见 `dataeng.hpp`)是可嵌入的事务排序组件:

- `addChange` 缓冲行变化并分配事务内版本号;`commit` 后按 `CommitKey{scn, subScn, xid}` 全局排序,提交顺序相同时以事务 id 作为公开并列键。
- `applyUndo` 按版本号精确撤销(回滚与补偿记录通用),版本缺失或重复撤销抛 `UndoVersionError`;`rollbackToVersion` 支持保存点回滚,`abort` 整体回滚。
- `resetThread` 开启新世代,旧世代未决事务作废,同一 xid 在新世代复用。
- `safeWatermark` / `advanceWatermark` 保证水位不越过任何未决事务;`drain` 只输出安全水位之内、按提交顺序排列的事务。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
ctest --test-dir build --output-on-failure
```
