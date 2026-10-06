# dict_compress — 词典切分压缩代价最小化

把长度 ≤ 30 的符号串 `s` 完整切分为候选片段（≤ 18 种）组成的序列，使总代价最小。

## 代价模型

```
总代价 = dict_cost × 用到的不同片段种数        （每种新增片段付一次字典费用）
       + Σ 每次引用 ( ref_cost + len_cost × 片段长度 )   （每次引用另付费用）
```

- 平局（总代价相同）时，输出**片段序列字典序最小**的方案（按片段字符串逐个比较）。
- 若候选片段无法拼出 `s`，判定为不可行。

## 算法

- 主求解器 `compress_min_cost`：状压 DP，状态为 `(切分位置, 已入词典的片段集合)`，
  复杂度 `O(n · 2^m · m)`（n ≤ 30, m ≤ 18），随后按候选字典序贪心重构最小片段序列。
- 参照实现 `compress_brute_force`：指数级枚举所有全切分，仅用于小例核验。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试含手写用例（字典复用、平局取小、不可行、长度费、空串、重复候选）以及
2000 组随机小例与暴力全切分的对拍（代价与片段序列均须一致）。

## CLI

```sh
./build/compress_cli <<'IN'
abab
3
a
b
ab
5 1 1
IN
# 输出:
# 11
# ab ab
```

输入：`s`、候选数 `m`、`m` 个候选片段、`dict_cost ref_cost len_cost`。
输出：最小总代价与空格分隔的最优片段序列；不可行时输出 `IMPOSSIBLE`。
