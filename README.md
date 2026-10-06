# dict_compress — 词典分片压缩最优切分

把长度 ≤ 30 的符号串切成词典片段，使总代价最小。

## 代价模型（题面假设的具体化）

- **字典费用**：每种*新增*片段类型支付一次，`dict_flat + dict_per_char * 片段长度`（默认 = 片段长度）。
- **引用费用**：每次引用（片段每出现一次）支付 `ref_flat + ref_per_char * 片段长度`（默认 = 片段长度）。
- **约束**：不同片段类型总数 ≤ `max_distinct`（默认 18）。
- **目标**：总代价最小；平局时取片段序列字典序最小者。

## 算法

关键观察：只有在中出现 ≥ 2 次的子串才可能被重复引用；其余"单次"片段永远支付
dict+ref，只占一个名额。因此 DP 状态为 `(位置, 已用可复用片段集合, 单次片段计数)`，
配合记忆化搜索；平局按片段序列字典序比较。`solve_brute` 枚举全部 2^(n-1) 种切分用于核验。

## 构建与测试

```sh
cmake -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试包含：全切分暴力对拍（{a,b}* 全枚举至长度 10、{a,b,c}* 至长度 7、随机串与随机
代价模型/名额约束）、已知手算用例、n=30 边界用例。

## CLI

```sh
./build/compress_cli <string> [max_distinct=18] [dict_per_char=1] [ref_per_char=1] [dict_flat=0] [ref_flat=0]
# 例：./build/compress_cli abababc  ->  cost 与最优片段序列
```
