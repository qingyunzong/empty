# allDifferent：二分匹配可行性检查与支持过滤

纯标准库实现（Python 3.11+），不调用 SAT/SMT 求解器。

- `alldiff.py`
  - `find_matching(domains)`：Hopcroft-Karp 最大匹配判定可行性；不可行时返回
    Hall 冲突集 `HallConflict`（变量集 S 及其邻域 N(S)，满足 |S| > |N(S)|）。
  - `filter_domains(domains)`：Régin 支持过滤——匹配边/非匹配边定向后求 SCC，
    删除不出现在任何最大匹配中的值，保持全部解。
  - 独立检查器：`brute_force_solution`（回溯穷举）、`validate_assignment`
    （对照原始约束验证赋值）、`exhaustive_supported_values`（逐值穷举支持集）。
- `test_alldiff.py`：unittest。含三变量域 {1,2} 不可行、固定值传播、
  无赋值变量的过滤，以及 400 组随机小实例与穷举支持集的全量对照。
- `demo.py`：运行样例。

运行：

```sh
python3 -m unittest -v
python3 demo.py
```
