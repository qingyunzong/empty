# mvcc-kv

单进程多副本 MVCC 键值存储，事务携带因果上下文（版本向量），Python 3.11+
标准库实现，无第三方依赖。

## 语义

- **begin(ctx)**: 以因果上下文 `ctx`（向量时钟，缺省全零）开启事务并返回快照。
- **read**: 只见快照因果之前的已提交版本（版本向量逐分量 `<= ctx`），
  多个可见版本按确定性全序 `(sum(vec), vec)` 取最大；事务可读自己的未提交写。
- **write**: 目标键存在与 `ctx` 并发（互不可比）的已提交版本时返回
  `WRITE_SKEW`；其他事务的未决写不产生冲突。
- **commit**: 再次校验全部写键的冲突，然后以 `ctx[replica]+1` 生成新版本
  向量并返回新的因果上下文；`abort` 无任何副作用。
- **gc**: 水印 = 所有活跃快照 `ctx` 的逐分量 min（无活跃快照时为 +inf）。
  低于水印且被同键另一版本严格支配的版本可回收；并发版本均保留。
- **超时**: `begin` 可带 `timeout_ms`，超时事务仅被标记为 `ABORTED`，
  其写永不提交、不可见，且不再参与 GC 水印。
- **限额**: 键 <= 500、版本 <= 5000（`MVCCStore` 可配置）。

## CLI

`python -m mvcc [--replicas N]`，标准输入输出 JSON 行：

```
{"op": "configure", "replicas": 3}
{"op": "begin",  "txn": "t1", "replica": 0, "ctx": [0,0,0], "timeout_ms": 1000}
{"op": "write",  "txn": "t1", "key": "k", "value": 42}
{"op": "commit", "txn": "t1"}            -> {"ok": true, "ctx": [1,0,0]}
{"op": "read",   "txn": "t1", "key": "k"}
{"op": "abort",  "txn": "t1"}
{"op": "gc"}                             -> {"ok": true, "watermark": [...], "collected": n}
```

语义错误（`WRITE_SKEW`、`TXN_ABORTED`、`TXN_NOT_ACTIVE`、`STORE_LIMIT`）
以 `{"ok": false, "error": CODE}` 返回，会话继续；协议错误（非法 JSON、
未知 op、缺字段）打印错误并以退出码 10 终止。

## 测试

```
python -m unittest discover -s tests -v
```

- `tests/test_mvcc.py`: 验收 A —— 随机枚举 <=3 副本、<=15 事务的场景，
  可见性与 WRITE_SKEW 判定对照独立参考串行化模型（Oracle）。
- `tests/test_semantics.py`: 验收 B/C/D —— 并发写同键必有一方
  WRITE_SKEW；活跃快照阻止 GC、关闭后可回收；超时事务 ABORTED 且写不可见。
- `tests/test_cli.py`: CLI 会话、错误码与 exit=10。
