# txgraph — 依赖图事务层

## 用法

CLI 从 stdin 逐行读取命令，`get` 结果写 stdout（缺失键输出 `NULL`）：

```
begin          开启（可嵌套）事务层
set k v        在当前层写入
depend a b     添加依赖边 a -> b；成环则命令失败（exit 3），事务保持有效
commit         当前层合入外层；最外层 commit 才写入全局可见状态
rollback       丢弃当前整层，回到其 begin 前的状态
savepoint s    在当前层建立保存点（仅本层有效）
undo s         回退到保存点 s，保留 s 之前的修改；s 之后定义的保存点失效
get k          读取当前事务视图（含未提交的外层写入）
```

## 退出码

- `0` 成功
- `2` 命令格式错误
- `3` 依赖成环
- `10` 未知 savepoint（含跨层 savepoint）
- `11` 无活动事务

首个命令出错即写 stderr 并以对应退出码终止。

## 语义要点

- 每层只记录本层增量（writes/edges），rollback 直接弃层，不会复活更内层
  已提交之外的修改；内层 commit 合入外层后，外层 rollback 会一并丢弃。
- savepoint 是本层快照；内层 commit 后其 savepoint 随之消失，外层 savepoint
  仍指向其定义时的外层状态。
- 环检测基于当前有效视图（已提交边 + 各层新增边），失败不改动任何状态。

## 文件

- `txstore.py` — 分层增量实现（Store / TxError）
- `txcli.py` — stdin 命令行前端
- `tests/test_tx.py` — 验收 A/B/C、CLI 端到端、随机序列 vs 全量快照影子模型（D）

## 测试

```
python3 -m unittest discover -s tests -v
```

实测结果（Python 3.14.4，stdlib only）：Ran 16 tests — OK（0.8s）。
