# genstore

单文件、按代际（generation）推进的 KV 存储，Python 3.11+ 标准库实现，无第三方依赖。

## 文件布局（页大小 4096）

| 区域 | 页 | 说明 |
|------|----|------|
| 头槽位 | 0..1 | 双备份头，槽位 = G % 2，含当前代际 G、根页号、数据页高水位，CRC 保护；头更新为单次小原子写，撕裂写 CRC 失败则回退备份头 |
| 尾区（journal） | 2..65 | redo 记录 + 至多一条 commit 标记，位置固定 |
| 数据页 | 66.. | 三级索引（根→中间→叶），根页号在头中，页更新一律 copy-on-write |

## 事务协议

1. `txn` 向尾区追加 redo 记录（逐条 fsync）
2. `commit` 先写 commit 标记（fsync），再 CoW 应用 redo 到索引（fsync），然后原子更新头 G+1（fsync），最后清理尾区
3. `rollback` 仅清理未提交尾区；若尾区含 commit 标记则拒绝（禁止回滚已提交代际）

## 故障点（只允许这四个）

- **A** 写 redo 中：尾区留下部分记录
- **B** 写 commit 标记中：留下撕裂标记（CRC 失败）
- **C** commit 标记后、头更新前
- **D** 头更新后、清尾区前

## 恢复规则

- A/B：无有效 commit 标记且尾区有崩溃残留 → 丢弃事务，G 不变（干净的挂起事务尾区保留，CLI 可跨进程）
- C：标记 g == G+1 → 重做已提交事务，头恰好更新一次，结果等于已提交，G 不重复
- D：标记 g == G → 已应用，仅清尾区
- 页 CRC 错误抛出 `PageCorruptError(page_no)` 定位页号；根损坏且无有效备份头 → `EmptyStore`（重置为空库）

## CLI

```sh
python -m genstore [--file PATH] txn set KEY VALUE
python -m genstore [--file PATH] txn del KEY
python -m genstore [--file PATH] commit
python -m genstore [--file PATH] rollback
python -m genstore [--file PATH] recover
python -m genstore [--file PATH] get KEY
python -m genstore [--file PATH] status   # 打印 G
python -m genstore [--file PATH] dump     # 打印全部键值
```

环境变量：`GENSTORE_PATH`（默认库文件）、`GENSTORE_FAULT=A|B|C|D`（注入一次性断电故障）。

## 测试

```sh
python -m unittest discover -s tests -v
```
