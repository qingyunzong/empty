# sergraph — 保留共享与环的 C++20 对象图序列化库

仅依赖 C++20 标准库的头文件库 (`include/ser/serializer.hpp`), 配 CMake/CTest 测试。

## 设计

- **稳定 ID, 与指针地址无关**: 序列化分两阶段。阶段一从根出发按字段声明序做
  广度优先扫描, 首次访问即分配递增 ID (1..N); 指针仅用作去重键, ID 取值完全由
  遍历顺序决定。因此同一逻辑图无论堆分配顺序如何, 输出字节完全一致
  (`test_stable_ids` 用精确字节流与不同分配顺序两个用例验证)。
- **共享与环**: 指针字段写成目标对象 ID (0 = 空)。反序列化先构造全部对象,
  再统一回填引用 (fixup 表), 任意环、自环、菱形共享均可往返; 回填时
  `dynamic_cast` 校验引用类型, 不匹配抛 `FormatError`。
- **异常安全, 全释放**: 反序列化期间所有已构造对象由
  `std::vector<std::unique_ptr<Serializable>>` 守卫持有, 任何抛出
  (未知类型 / 格式错误 / 工厂注入失败) 都会整体释放, 成功后所有权移交给
  返回的 `Graph`。测试类型用 `live_count` 构造/析构计数严格核对零泄漏。
- **未知类型拒绝**: 类型名必须在 `Registry` 注册, 否则抛 `UnknownTypeError`;
  序列化未注册类型抛 `ser::Error`。另校验: 顺序 ID、悬空引用、计数合理性
  (防恶意输入触发巨额分配)、尾部垃圾、截断输入。

## 格式 (文本, 长度前缀字符串可含任意字节)

```
SER1 <count>
O <id> <type>
I <int> | S <len> <bytes> | R <id>
E
...
```

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
cd build && ctest --output-on-failure
```

测试目标 (ASan+UBSan 编译, `-Wall -Wextra -Wpedantic` 无警告):

| 测试 | 内容 |
|---|---|
| `basic` | 空图 / 负整数与极值 / 含空格换行 NUL 的字符串往返 |
| `sharing_cycles` | 菱形共享、自环、互环、三环+共享尾的别名保持 |
| `stable_ids` | 精确字节流断言; 不同分配顺序输出一致; 重复序列化确定 |
| `random_graph` | 固定种子 300 组随机循环图: 可达数一致、再序列化字节一致 (别名完备保持)、值唯一性 |
| `errors` | 未知类型拒绝; 5 个构造点逐一注入失败均零泄漏; 悬空引用 / 类型不匹配 / 截断 / 坏魔数 / 非顺序 ID / 荒谬计数 |

注: 本容器 ptrace 受限, LeakSanitizer 无法运行, CMake 配置期自动探测并对
CTest 设置 `ASAN_OPTIONS=detect_leaks=0`; 泄漏由测试内 `live_count` 计数严格校验
(正常环境下 LSan 自动启用)。

## 实际测试结果 (2026-10-06, GCC 15.2.0, CMake 4.2.3, ASan+UBSan)

```
Test project .../build
    Start 1: basic
1/5 Test #1: basic ............................   Passed    0.04 sec
    Start 2: sharing_cycles
2/5 Test #2: sharing_cycles ...................   Passed    0.03 sec
    Start 3: stable_ids
3/5 Test #3: stable_ids .......................   Passed    0.03 sec
    Start 4: random_graph
4/5 Test #4: random_graph .....................   Passed    0.62 sec
    Start 5: errors
5/5 Test #5: errors ...........................   Passed    0.10 sec

100% tests passed, 0 tests failed out of 5
```
