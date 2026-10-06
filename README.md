# manhattan_path

整数坐标折线路径库（C++20，头文件唯一，仅依赖标准库）。

## 功能

- `insert(index, p)` / `erase(index)`：任意位置插点、删点，重复点合法。
- `length(l, r)`：区间曼哈顿长度，即相邻点对 `|dx| + |dy|` 在 `l <= i < r`
  上的和；区间首尾不含外侧连接。`total_length()` 给出全长。
- 修改以 `__int128` 预检：若新总长超出 `int64_t`，操作被拒绝并返回
  `false`，路径保留旧版本。
- 基于隐式 Treap，插入/删除/区间查询期望 `O(log n)`。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试包括单元测试（`tests/test_unit.cpp`）和随机操作对照测试
（`tests/test_random.cpp`，与 `std::vector` 重算参考逐操作比对，
可用 `./build/path_random_tests <seed> <ops>` 自定义规模）。
