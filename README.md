# mvcc-kv

单进程多副本 MVCC 键值存储，事务携带因果上下文（向量时钟），Python 3.11 标准库实现。

## 语义

- `begin(ctx)` 固定快照：读只见版本向量 `<= ctx` 的已提交版本（取因果最大者）。
- 写冲突：目标键存在对 `ctx` 不可见（并发或更晚）的已提交版本时返回 `WRITE_SKEW`，
  写时与提交时各校验一次。
- `commit` 生成新版本向量（副本时钟与 ctx 合并后本地分量 +1），并作为新因果上下文返回；
  `abort` 无副作用。
- `gc` 水位 = 所有活跃快照 ctx 的逐分量 min（无活跃快照时为全部副本时钟的 merge）；
  低于水位且被另一仍 `<=` 水位的版本支配的版本被回收。
- 超时事务仅被标记 `ABORTED`，其写永不可见；未决事务不影响其他事务。
- 上限：键 <= 500（`KEY_LIMIT`），版本 <= 5000（`VERSION_LIMIT`）。

## CLI

    python -m mvcc <<'CMDS'
    {"cmd":"init","replicas":3}
    {"cmd":"begin","txn":"t1","replica":"r0"}
    {"cmd":"write","txn":"t1","key":"a","value":1}
    {"cmd":"commit","txn":"t1"}
    {"cmd":"begin","txn":"t2","replica":"r1","ctx":{"r0":1}}
    {"cmd":"read","txn":"t2","key":"a"}
    {"cmd":"gc"}
    CMDS

每行一个 JSON 命令，每行输出一个 JSON 响应；任一命令出错时进程退出码为 10。

## 测试

    python -m unittest discover -s tests -v
