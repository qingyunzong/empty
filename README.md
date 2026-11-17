# dlks_formal

可嵌入的 C++20 向量化表达式组件。它面向数据库/执行器场景：在**选择向量**
（`Selection`）上批量求值，支持 SQL 风格**三值逻辑**、逐行**短路求值**、
**可空列传播**，并保证被短路行上的危险运算（除零、溢出、失败的类型转换、
用户函数、字典物化）不会执行。组件同时提供独立的**标量解释器**作为对照实现，
以及随机批次差分测试，逐位置核对值、NULL 位、错误节点与异常位置。

## 核心语义

### 类型与 NULL

- 值类型：`Null`、`Bool`、`Int64`、`Double`、`String`。
- NULL 是独立状态，不等同于 `false`、`0` 或空串；`Vector` 用独立 null bitmap
  记录，NULL 位参与向量相等性比较。
- 算术、比较、类型转换、用户函数均按 SQL 语义传播 NULL；`is_null(x)` 是
  唯一把 NULL 变为非 NULL 布尔值的构造。

### 三值逻辑（Kleene）

`AND`：

| AND | TRUE | FALSE | NULL |
| --- | --- | --- | --- |
| TRUE | TRUE | FALSE | NULL |
| FALSE | FALSE | FALSE | FALSE |
| NULL | NULL | FALSE | NULL |

`OR`：

| OR | TRUE | FALSE | NULL |
| --- | --- | --- | --- |
| TRUE | TRUE | TRUE | TRUE |
| FALSE | TRUE | FALSE | NULL |
| NULL | TRUE | NULL | NULL |

`NOT NULL = NULL`。`NULL == NULL`、`NULL < 1` 等比较结果均为 NULL。

### 短路与求值顺序

- `lhs AND rhs`：只在 `lhs` 不为 FALSE 的行上求值 `rhs`；
  `lhs OR rhs`：只在 `lhs` 不为 TRUE 的行上求值 `rhs`。
- `NULL AND rhs` 必须求值 `rhs`（`NULL AND FALSE = FALSE`），因此 NULL
  本身不短路；但 FALSE/TRUE 会短路。
- `if(cond, then, else)`：按行只求值被选中的分支；`cond` 为 NULL 时结果为
  NULL（这是三值 `if`，不是 SQL `CASE WHEN` 的 ELSE 语义）。
- `coalesce(a, b)`：只在 `a` 为 NULL 的行上求值 `b`。
- 函数参数严格：任一参数为 NULL 时不调用函数；但 NULL 参数不会阻止后续参数
  求值。若某个参数在某行报错，该行后续参数与函数调用都不再执行。
- 二元算术/比较：先整体求值左支，再只在左支无错误的行上求值右支。左支错误
  会阻止右支执行；NULL 左支不会阻止右支执行。
- 同一行内按“左→右、子→父”的求值顺序确定第一个错误；整批结果按**选择位置
  顺序**取第一个错误。被短路/未选中的行既不会产生值，也不会产生错误。

### 错误模型

行内错误不会中断整批求值，而是逐行收集到 `Evaluation::errors`：

```cpp
struct ErrorInfo {
  std::uint32_t node_id;  // 表达式节点编号；kNoError 表示成功
  std::string message;
};
```

节点编号在 `compile()` 时按后序分配（子节点编号小于父节点），因此同一 AST
在标量/向量引擎中编号一致。选择位置、基础行号、节点编号与错误消息共同构成
可精确比对的“异常位置”。`evaluate_or_throw()` 会在整批结束后抛出携带这些
信息的 `EvalError`。

### 字典列延迟物化

`DictionaryColumn` 只保存每行 code，按需调用 provider 物化并缓存结果（包括
失败结果）。`read(selection)` 只解码选择中的行，因此：

- 未被选择的行不会物化；
- 被 `AND`/`OR`/`if`/`coalesce` 短路掉的行不会物化；
- 相同 code 在一次求值中只物化一次；
- provider 抛出的异常成为该行的普通行内错误，不影响其他行。

## 快速开始

```cpp
#include "dlks_formal.hpp"

dlks::Batch batch;
batch.add("amount", std::make_shared<dlks::InMemoryColumn>(
    dlks::Vector::from_values(dlks::Type::Int64,
        {dlks::Value(4), dlks::Value(0), dlks::Value(25), dlks::Value{}})));

dlks::Registry registry;
auto expr = dlks::Expr::binary(
    dlks::Op::And,
    dlks::Expr::binary(dlks::Op::Ne, dlks::Expr::column("amount"),
                       dlks::Expr::literal(dlks::Value(0))),
    dlks::Expr::binary(
        dlks::Op::Gt,
        dlks::Expr::binary(dlks::Op::Div, dlks::Expr::literal(dlks::Value(100)),
                           dlks::Expr::column("amount")),
        dlks::Expr::literal(dlks::Value(5))));

dlks::Program program = dlks::compile(expr, batch, registry);
dlks::Evaluation result =
    dlks::VectorEngine(batch).evaluate(program, dlks::all_rows(batch.size()));
std::cout << dlks::describe_evaluation(result) << "\n";
// bool[true, false, false, null]：amount=0 的行被短路，不会除零
```

完整示例见 `examples/demo.cpp`。

## 主要 API

| 文件 | 内容 |
| --- | --- |
| `include/dlks/value.hpp` | `Type`、`Value` |
| `include/dlks/vector.hpp` | `Vector`（typed buffer + null bitmap）、`Selection` |
| `include/dlks/column.hpp` | `Column`、`InMemoryColumn`、`DictionaryColumn`、`Batch` |
| `include/dlks/kernel.hpp` | 标量核函数、类型转换、溢出/除零检查、`KernelError` |
| `include/dlks/expr.hpp` | `Expr`、`Registry`、`compile()`、静态类型推导 |
| `include/dlks/eval.hpp` | `Evaluation`、`ErrorInfo`、`EvalError` |
| `include/dlks/vector_engine.hpp` | `VectorEngine`（选择向量批量求值） |
| `include/dlks/scalar_engine.hpp` | `ScalarEngine`（逐行对照解释器） |
| `include/dlks/differential.hpp` | 值/NULL/错误/调用次数差分比较 |
| `include/dlks/random.hpp` | 随机数据集、类型正确的随机表达式、随机选择向量 |

引擎共享同一套核函数与 AST，但控制流独立：`VectorEngine` 通过收窄 selection
实现逐行短路，`ScalarEngine` 按行递归求值，用于捕获选择映射、NULL 位组装、
错误优先级等方面的偏差。

## 差分验证

`tests/test_differential.cpp` 对每个随机种子：

1. 生成含 NULL 的 Int64/Double/Bool/String 列，以及带失败 code 的延迟字典列；
2. 生成静态类型正确的随机表达式（含 `AND`/`OR`、嵌套 `if`/`coalesce`、
   除零、溢出、失败 cast、`boom` 用户函数与字典物化）；
3. 生成全量、空、随机子集、乱序、重复行等选择向量；
4. 分别运行标量解释器与向量化引擎，逐位置比较：
   值、NULL 位、错误是否存在、错误节点编号、错误消息；
5. 额外比较用户函数调用次数与字典实际物化的 code 集合，确保危险操作确实
   没有在被短路行执行。

默认 300 组种子；可扩展到数千组：

```bash
./build/dlks_tests --seeds=5000
./build/dlks_tests --filter=differential --seeds=20000 --seed-base=12345
```

## 构建与测试

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
./build/dlks_demo
```

Sanitizer 构建：

```bash
cmake -S . -B build-san -DCMAKE_BUILD_TYPE=Debug -DDLKS_SANITIZE=ON
cmake --build build-san -j
ASAN_OPTIONS=detect_leaks=0 ctest --test-dir build-san --output-on-failure
```

部分受限容器中 LeakSanitizer 无法在 ptrace 下工作，此时用
`ASAN_OPTIONS=detect_leaks=0` 关闭泄漏检测，地址/未定义行为检查仍然生效。

## 边界与限制

- 单线程组件；`DictionaryColumn` 的缓存与计数器不加锁。
- `Program` 在编译时复制所引用的函数定义（`std::function` 共享其捕获状态），
  因此 `Registry` 不必比 `Program` 活得更久。
- 数值混合算术提升为 `Double`；比较则对 Int64/Int64 与 Int64/Double 做精确
  判定，避免大整数转 double 丢失精度。
- 整数溢出、除零、模零、非有限 Double 结果均作为行内错误；整数除法向零截断，
  `INT64_MIN % -1` 定义为 0。
- 字符串转数值是严格解析：不接受前后空白、`+` 号或部分匹配；非法输入是
  行内错误。
- `if` 的 NULL 条件结果为 NULL；如需 SQL `CASE` 语义可在表达式外层用
  `coalesce`/`is_null` 显式处理。
- 选择向量允许重复与乱序；错误位置以选择位置为主序，`EvalError::row()` 同时
  给出基础行号。
- 本实现的“向量化”指 selection/批次级列式求值，不使用 SIMD intrinsics；
  重点是可嵌入、语义精确和可差分验证。
