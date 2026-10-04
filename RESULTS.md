# RESULTS

日期：2026-10-04 ｜ 环境：Python 3.14.4（代码兼容 3.11+，仅标准库）

## 测试运行（真实结果）

命令：`python3 -m unittest discover -v`

- 结果：`Ran 31 tests`，**OK**（exit=0），耗时 15.955s
- 31 个测试全部通过，覆盖四个模块：

| 模块 | 测试数 | 内容 |
|---|---|---|
| `tests.test_core` | 20 | 并列 ts 由 did 字典序决胜、stale/no_dim 区分、维度覆盖规则（同 ts 后到达无效、更高 ts 覆盖、跨 key 迁移）、FWM 迟到事实丢弃、DWM 未到期不输出、晚到维度在 tol 内改变结果、输出按 (ts,fid) 排序、tol 边界含/不含、tol=0 |
| `tests.test_bruteforce` | 2 | 枚举对照：36 种维度 × 长度≤2 全序列（1333）× 12 种事实 × 长度≤2 全序列（157）× tol∈{0,1,2}，共 628,047 例与独立暴力参考逐一相等；随机 3000 例（0–9 事实、0–9 维度）对照 |
| `tests.test_cli` | 9 | 基本 join、晚到维度改变结果、空行跳过、坏 JSON/缺字段/类型错/tol<0/文件不存在均 exit 2 |

## CLI 冒烟（真实输出）

```
$ python3 -m asofjoin --facts F.jsonl --dim D.jsonl --tol 20000
{"fid": "f1", "ts": 1500, "did": "d1", "attr": "blue", "reason": null}
{"fid": "f2", "ts": 10000, "did": "d3", "attr": "green", "reason": null}
{"fid": "f3", "ts": 40000, "did": null, "attr": null, "reason": "stale"}
exit=0
```

（f1 命中 ts=1000 并列的 d1/d2，由 did 字典序取 d1；f4 因 ts=10000 < FWM=40000 作为迟到事实被丢弃。）

错误路径实测：坏 JSON 行 → `error: ...:1: invalid JSON ...`，exit=2；`--tol -5` → argparse 报错，exit=2。

## 验收对照

1. n≤9 枚举对照暴力参考：`test_all_sequences_up_to_len2`（62.8 万例）+ `test_random_cases_up_to_9_records`（3000 例）✅
2. 并列 ts 由 did 决胜：`test_equal_ts_picks_smallest_did` ✅
3. 维度晚到但在 tol 内改变结果：`test_late_dim_within_tol_changes_result`、`test_late_override_within_tol_changes_result`、CLI `test_late_dim_within_tol_changes_result` ✅
4. stale 与 no_dim 区分：`TestStaleVsNoDim` 4 例（含未来维度不算 no_dim 候选、无维度时因 DWM 未到期不输出）✅
