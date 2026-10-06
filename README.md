# linklib — 迷你链接工具库 (C++20)

一个按入口符号、强弱符号与节引用进行解析的链接器库，附带独立的全图解释器作为对照预言机（oracle）。仅使用 C++20 标准库。

## 功能

- **符号解析**（`src/linker.cpp`）
  - 按对象输入序收集所有定义；同一符号出现多个强定义时抛出 `LinkError`（强定义冲突拒绝）。
  - 恰好一个强定义时胜出（可覆盖任意数量弱定义）。
  - 仅弱定义时，按对象输入序取第一个。
- **可达性扫描**：从入口符号所在节做广度优先遍历，沿重定位中的节引用传播；访问集合保证循环引用合法且终止。
- **节 GC**：不可达节被丢弃并记录在 `gc_sections`；死节中对未定义符号的引用不导致链接失败。
- **地址分配与重定位**：保活节按（对象序, 节序）布局并遵守对齐；支持 `Abs32`/`Abs64` 小端重定位，Abs32 溢出报错。
- **绑定证据**：`LinkResult::bindings` 记录每个符号绑定到哪个对象的哪个定义及原因；`KeptSection::reason` 记录每节的可达路径证据。
- **全图解释器对照**（`src/interpreter.cpp`）：独立实现的 oracle——按符号重扫全部对象做解析、深度优先遍历全图求活集、对给定布局求值每个重定位表达式。`tests/test_util.h` 的 `cross_check` 对活集、绑定、每个重定位点的字节值与入口地址逐项断言一致。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
cd build && ctest --output-on-failure
```

## 测试（CTest）

| 测试 | 覆盖点 |
|---|---|
| `basic` | 入口解析、布局/对齐、Abs32/Abs64 重定位字节、绑定与可达性证据 |
| `conflicts` | 强定义冲突拒绝、未定义入口、未定义引用、Abs32 溢出 |
| `weak` | 强覆盖弱、弱定义按输入序、输入重排改变结果、弱定义满足外部引用 |
| `gc` | 不可达节回收、死节中未定义引用不报错 |
| `circular` | 双节点互引、自引循环合法且终止，重定位值互相一致 |
| `oracle` | 固定种子伪随机图（10 对象 × 3 节 + 弱副本 + 死对象，含环）与全图解释器对照 |

## 实际测试结果

环境：cmake 4.2.3，g++ 15.2.0（Ubuntu），C++20，2026-10-06 运行：

```
1/6 Test #1: basic ............................   Passed    0.00 sec
2/6 Test #2: conflicts ........................   Passed    0.00 sec
3/6 Test #3: weak .............................   Passed    0.00 sec
4/6 Test #4: gc ...............................   Passed    0.00 sec
5/6 Test #5: circular .........................   Passed    0.00 sec
6/6 Test #6: oracle ...........................   Passed    0.00 sec

100% tests passed, 0 tests failed out of 6
```

## 结构

```
include/linker.h      公共 API：对象模型、LinkResult、Linker、解释器
src/linker.cpp        解析 / 活集 / 布局 / 重定位 / 证据
src/interpreter.cpp   全图解释器（独立 oracle）
tests/                CTest 测试与 cross_check 工具
```
