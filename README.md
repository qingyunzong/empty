执行器需要可嵌入的C++20外部排序组件，在内存预算下生成有序游程并做稳定 k 路归并，处理相等键顺序。游程切分点由预算确定，归并相等键按原始来源稳定排序，结果多重集与输入一致。用小数据穷举预算与切分，对照朴素全量排序核对结果序列与计数，游程生成与归并交错时不丢键或乱序。

## 组件

`include/dlks_formal.hpp`（header-only，C++20）：

- `dlks_formal::external_sorter<T, Compare>`：`push()` 流式喂入，内存预算（`memory_budget >= 2`）决定游程切分点与归并 fan-in；游程生成与 k 路归并自动交错进行；`finish()` 后可用 `next()` 逐个拉取或 `drain(out)` 输出。相等键按来源游程序号决胜，保证对原始输入顺序稳定。
- `dlks_formal::external_sort(first, last, out, budget, cmp)`：一次性便捷接口。

## 测试

```sh
cmake -S . -B build && cmake --build build
cd build && ctest --output-on-failure
```
