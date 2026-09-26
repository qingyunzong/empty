# allDifferent：二分匹配可行性检查与支持过滤

Python 3.11，仅标准库，不使用任何 SAT/SMT 求解器。

## 原理

`allDifferent(x1, ..., xn)` 在有限域上的可行性等价于二部图
`变量 —（域内取值）— 值` 是否存在覆盖全部变量的匹配（Hall 婚姻定理）。

- `check_feasible(domains)`：Kuhn 增广路最大匹配；不可行时沿“自由边/匹配边”
  交替可达性返回一个被违反的 Hall 集合（`HallConflict(variables, values)`，
  满足 `|variables| > |values|`，`values` 是这些变量域的并）。
- `propagate(domains)`：全局支持过滤，保留“至少出现在一个完美匹配中”的
  `(变量, 值)` 对。基于 Dulmage–Mendelsohn 结构（迭代 Kosaraju 强连通分量
  + 到未匹配值的交替路），比“只检查已赋值变量两两不相等”严格更强；
  不可行时返回 Hall 冲突且不产生剪枝结果。
- 声称有解时返回一个见证匹配；`src/independent_check.py` 用与匹配算法
  完全独立的笛卡尔积穷举来验证见证满足原约束、原域，并给出穷举支持集。

## 运行

```sh
python3.11 demo.py
python3.11 -m unittest discover -s tests -v
```

## 关键测试

- 三个变量、域均为 `{1,2}`：不可行，Hall 集合为 `{x,y,z}` vs `{1,2}`。
- `z=1` 固定后，值 `1` 从 `x`、`y` 域中被移除。
- 朴素“两两已赋值”检查放行、但全局 Hall 集合不可行的反例。
- 400 个随机小规模实例：可行性、见证、剪枝后支持集全部与穷举一致。
