# rope — 持久化字节绳（C++20）

头文件库（`include/rope/rope.hpp`），仅依赖 C++20 标准库。

## 特性

- **字节级操作**：`slice` / `concat` / `insert` / `erase` / `replace`，全部按字节偏移工作。
- **持久化（旧视图保留）**：所有操作返回新 `Rope`，绝不修改原对象；节点不可变，
  通过 `std::shared_ptr<const Node>` 共享，旧视图永远有效。
- **缓存长度防溢出**：每个节点缓存子树字节长度；拼接用 `detail::checked_add`
  做检查加法，溢出时抛 `std::length_error` 而非回绕。
- **任意切分不破坏 UTF-8 边界查询**：`is_char_boundary` / `floor_char_boundary` /
  `ceil_char_boundary` 通过跨节点的 `byte_at` 取字节判断，即使切分点落在多字节
  字符内部，边界查询依然正确（与等长 `std::string` 上的参考实现逐点对拍）。
- **节点共享、回收安全**：`shared_ptr` 自动回收；`Node::live_count` 诊断计数器
  在测试中精确验证共享与回收（无泄漏、无提前释放）。
- **结构自平衡**：叶子最大 1024 字节，相邻小叶子合并；树高超过 64 时复用现有
  叶子重建平衡树，防止退化为深链。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
cd build && ctest --output-on-failure
```

测试（`tests/rope_tests.cpp`，自带轻量断言框架，无第三方依赖）：

| CTest 用例 | 内容 |
|---|---|
| `rope_unit` | 空串、拼接/切片/替换/插入/删除、大串分块、越界抛异常、旧视图保留 |
| `rope_utf8` | 含 2/3/4 字节字符的串，在**每个字节位置**切分拼接后逐点对照边界查询；任意字节区间切片对照 |
| `rope_random` | 固定种子 4000 步随机 insert/erase/replace/快照，与 `std::string` 预言机对照；历史快照全部回读验证 |
| `rope_lifetime` | `live_node_count` 精确验证：拼接共享子树、切片共享、视图存活期间共享节点不被回收、全部释放后计数归零 |
| `rope_overflow` | 检查加法溢出抛 `std::length_error`；大拼接长度正确 |

## 实际测试结果

环境：g++ 15.2.0，CMake 4.2.3，Linux x86-64。

普通构建（`ctest`）：

```
1/5 Test #1: rope_unit ........................   Passed    0.00 sec
2/5 Test #2: rope_utf8 ........................   Passed    0.00 sec
3/5 Test #3: rope_random ......................   Passed    0.02 sec
4/5 Test #4: rope_lifetime ....................   Passed    0.00 sec
5/5 Test #5: rope_overflow ....................   Passed    0.00 sec
100% tests passed, 0 tests failed out of 5
```

各用例断言计数（`rope_tests <case>` 直接运行）：

```
unit: 794 checks, 0 failures
utf8: 3417 checks, 0 failures
random: 3621 checks, 0 failures
lifetime: 15 checks, 0 failures
overflow: 7 checks, 0 failures
```

ASan+UBSan 构建（`-fsanitize=address,undefined`，沙箱禁用 ptrace 故关闭
LSan 泄漏检测；节点回收由 `rope_lifetime` 的精确计数覆盖）：

```
100% tests passed, 0 tests failed out of 5   (Total Test time 0.12 sec)
```

## API 速览

```cpp
#include <rope/rope.hpp>
using rope::Rope;

Rope a = Rope::from("hello ");
Rope b = Rope::from("世界");
Rope c = a.concat(b);                 // a、b 不变
Rope d = c.replace(6, 3, "界世");     // 旧视图 c 保留
c.is_char_boundary(6);                // true
c.floor_char_boundary(7);             // 6（跨节点安全）
Rope e = c.slice(0, 7);               // 可在多字节字符中间切
Rope::live_node_count();              // 诊断：当前存活节点数
```
