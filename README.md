# asofjoin

流式 as-of join 库与 CLI（纯 Python 3.11+ 标准库，无第三方依赖）。

## 用法

```
python -m asofjoin --facts F.jsonl --dim D.jsonl --tol 20000
```

- 事实行: `{"fid": "...", "key": "...", "ts": 123}`
- 维度行: `{"did": "...", "key": "...", "ts": 123, "attr": ...}`
- 输出: 每个事实一行 JSON，按 `(fact.ts, fid)` 排序：
  `{"fid","key","ts","did","attr","reason"}`，匹配时 `reason="ok"`，
  无匹配时 `did=null, attr=null, reason="no_dim"|"stale"`。
- 坏行（非法 JSON / 缺字段 / 类型错误）或 `tol < 0`：退出码 2。

## 语义

- 对每个事实，在同 key 且 `fact.ts - tol <= dim.ts <= fact.ts` 的维度中取 ts 最新者；
  ts 并列取 did 字典序最小。
- DWM（维度水位线）> `fact.ts - tol` 且 FWM（事实水位线）> `fact.ts` 时才输出，
  避免未来事件改变选择；输入结束时冲刷全部挂起事实。
- 维度可乱序；重复 did 以 ts 更高者覆盖，同 ts 后到达无效。
- 事实 ts 小于 FWM 视为迟到，直接丢弃。
- 未到期的维度缺失不会被当作不可满足（事实保持挂起而非提前输出 no_dim）。

## 测试

```
python -m unittest discover -v
```

结果记录见 `RESULTS.md`。
