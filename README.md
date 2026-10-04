# rope — C++20 持久化绳（rope）库

头文件库（`include/rope/rope.hpp`），仅依赖 C++20 标准库。

## 设计

- **字节切片 / 拼接 / 替换**：`slice(pos,len)`、`concat`、`replace(pos,len,with)` 均按字节偏移工作，越界抛 `std::out_of_range`。
- **旧视图保留（持久化）**：所有节点不可变，派生新绳时与旧绳共享子树；任何旧视图永远有效且内容不变（无写时复制、无原地修改）。
- **缓存长度防溢出**：每个节点缓存子树总字节数；拼接经 `detail::checked_add` 做 `size_t` 溢出检查，溢出抛 `std::length_error`。
- **UTF-8 边界查询与切分无关**：`is_char_boundary` / `floor_char_boundary` / `ceil_char_boundary` 定义在扁平字节序列上（经 `operator[]` 跨叶读取），因此任意切分点——即使落在多字节码点中间——都不影响边界查询结果。
- **节点共享回收安全**：节点由 `std::shared_ptr<const node>` 持有，最后一个引用它的视图销毁时自动回收；切片共享叶节点底层缓冲区（`shared_ptr<string>` + 偏移窗口）。
- **平衡**：拼接后深度超过 128 时收集叶子重建平衡树，保证 `operator[]`/遍历不退化。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
cd build && ctest --output-on-failure
# 可选：ASan+UBSan
cmake -S . -B build-san -DROPE_SANITIZE=ON && cmake --build build-san
cd build-san && ASAN_OPTIONS=detect_leaks=0 ctest --output-on-failure
```

## 测试用例（tests/rope_tests.cpp）

- `basic`：切片/拼接/替换/越界/空绳/10 万字节分块重组。
- `persistence`：链式派生 5 个版本后逐一校验旧视图内容不变。
- `utf8_boundaries`：200 轮随机多字节文本 + 随机（可能跨码点）切分，全部位置对照 `std::string` 参考实现；另对含 1–4 字节码点的串枚举所有子串切片逐一校验。
- `random_fuzz`：固定种子 4000 步随机操作（插入/删除/替换/切片/拼接/边界抽查），每步对照 `std::string` 模型并校验缓存长度与树深上界。
- `lifetime`：用 `weak_ptr` 观察节点寿命——派生视图存续期间共享节点不被回收，所有视图销毁后节点全部回收；切片共享的叶缓冲区在原绳销毁后仍存活。
- `overflow`：`checked_add` 边界值单测 + 伪造近 `SIZE_MAX` 缓存长度验证 `make_concat` 抛 `length_error`。

## 实际测试结果

环境：g++ 15.2.0，CMake/CTest 4.2.3，Linux x86-64。

普通构建（Debug）：

```
1/6 Test #1: basic ............................   Passed    0.00 sec
2/6 Test #2: persistence ......................   Passed    0.00 sec
3/6 Test #3: utf8_boundaries ..................   Passed    0.03 sec
4/6 Test #4: random_fuzz ......................   Passed    0.02 sec
5/6 Test #5: lifetime .........................   Passed    0.00 sec
6/6 Test #6: overflow .........................   Passed    0.00 sec
100% tests passed, 0 tests failed out of 6
```

ASan+UBSan 构建（`-fsanitize=address,undefined`，关闭泄漏检测——本容器 ptrace 受限导致 LeakSanitizer 无法运行；回收正确性已由 `lifetime` 用例通过 `weak_ptr` 过期检查覆盖）：

```
100% tests passed, 0 tests failed out of 6   (Total Test time 0.27 sec)
```
