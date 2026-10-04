# asofjoin

事实流与维度流的 as-of join（Python 3.11+ 标准库，无第三方依赖）。

## 用法

```
python3 -m asofjoin --facts F.jsonl --dim D.jsonl --tol 20000
```

- 事实行：`{"fid": str, "key": str, "ts": int}`
- 维度行：`{"did": str, "key": str, "ts": int, "attr": any}`
- 输出（stdout，JSONL，按 `(fact.ts, fid)` 排序）：
  `{"fid", "ts", "did", "attr", "reason"}`；未命中时 `did/attr` 为 `null`，
  `reason` 为 `no_dim`（同 key 无 ts≤fact.ts 的维度）或 `stale`（有但超出 tol）。
- 坏行、缺/错字段、`tol<0`、文件不可读 → exit 2。

## 语义

- 对每个事实，在同 key 维度中选 `ts <= fact.ts` 且 `fact.ts - dim.ts <= tol` 的最新者；
  并列最新 ts 取 did 字典序最小。
- 水位线：DWM = 维度最大到达 ts。仅当 `DWM > fact.ts - tol` 才输出该事实的结果，
  未到期（维度可能仍未到齐）不输出，也不会误判为 no_dim/stale。
- 维度可乱序；同一 did 重复到达时，仅 ts 严格更高者覆盖，同 ts 后到达无效。
- 事实水位线 FWM = 事实最大到达 ts；`ts < FWM` 的迟到事实直接丢弃。

## 测试

```
python3 -m unittest discover -v
```

结果记录见 `RESULTS.md`。
