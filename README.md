# deptx — 依赖图事务层

分层事务（可嵌套）+ 有向依赖图（环检测）+ 键值存储，纯 Python 3.11 标准库实现。

## 运行

```sh
python -m deptx              # 从 stdin 逐行读取命令
python -m deptx script.txt   # 或从文件读取
```

## 命令

| 命令 | 语义 |
| --- | --- |
| `begin` | 开启新事务层（可嵌套） |
| `set k v` | 在当前层写入键值 |
| `depend a b` | 添加依赖边 a→b；成环则命令失败（exit 3），事务层保持有效 |
| `commit` | 当前层合入外层；最外层 commit 才写入已提交基态 |
| `rollback` | 整体丢弃当前层，恢复到其 begin 之前 |
| `savepoint s` | 在当前层建立保存点（仅本层有效） |
| `undo s` | 回滚当前层到保存点 s，保留 s 之前的修改；s 之后的保存点失效 |
| `get k` | 读取当前事务视图（无事务时读已提交基态），缺失打印 `None` |

## 退出码

- `0` 全部命令成功
- `3` 依赖成环
- `10` 未知 savepoint（含跨层 savepoint）
- `11` 无活动事务
- `2` 用法/解析错误

单条命令失败会打印到 stderr 并继续处理后续命令，进程退出码为首个失败命令的退出码。

## 测试

```sh
python -m unittest discover -s tests -v
```
