# rbatch — C++20 资源批次库

申请多个资源句柄；任一项失败时逆序释放已取得资源并重新抛出原异常。
句柄可移动、不可复制，析构恰好释放一次；释放回调允许抛异常，批次清理
仍会释放其余全部句柄。

## 结构

- `include/rbatch/handle.hpp` — `rbatch::Handle`：单一资源的 RAII 句柄。
  - 删除拷贝构造/拷贝赋值；移动构造/移动赋值为 `noexcept`。
  - 移动后源句柄置空（`valid() == false`），不会重复释放。
  - `release()` 先把句柄置空调用回调：回调抛异常时异常向外传播，但
    句柄已为空，析构不会二次释放。
  - 析构永不抛异常（回调异常被吞没），保证栈展开与批量清理可继续。
- `include/rbatch/batch.hpp` — `rbatch::ResourceBatch` 与 `acquire_batch`。
  - `acquire_batch(count, factory)` 依次调用 `factory(0..count-1)`；
    第 k 项抛异常时，已取得的 k 个句柄按逆序释放后重新抛出原异常。
  - 析构/`release_all()` 按逆序（最新优先）逐个释放，每个释放都在
    try/catch 中，回调抛异常不影响其余句柄的释放。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 测试覆盖（tests/test_batch.cpp）

- `type_traits` — 静态断言：Handle/ResourceBatch 可移动、不可复制。
- `success_release_order` — 5 项全部成功：存活期零释放，析构轨迹
  恰好为 [4,3,2,1,0]。
- `failure_at_k` — 对 k = 0..4 注入第 k 项失败：已取得句柄逆序释放
  [k-1..0]，原异常透传；其中 id=1 的释放回调被设为抛异常，回滚仍
  释放全部已取得句柄。
- `move_chain` — 句柄移动链（移动构造 + 移动赋值）：移动赋值先释放
  旧资源一次，最终所有者析构时资源 7 恰好释放一次；批次整体移动链
  同样只在最后释放一次。
- `throwing_release` — id=1、3 的回调抛异常：批次析构轨迹仍为完整
  的 [3,2,1,0]，不 terminate；单个句柄析构回调抛异常同样安全。
- `release_once` — 手动 `release()` 后析构为 no-op；回调抛异常时
  `release()` 传播异常但句柄已置空，绝不二次释放。

## 实际测试结果

环境：GCC 15.2.0，CMake 4.2.3，Ubuntu（x86_64），C++20，
`-Wall -Wextra -Wpedantic -Werror` 零告警。

普通构建（Debug）：

```
1/6 Test #1: type_traits ......................   Passed    0.00 sec
2/6 Test #2: success_release_order ............   Passed    0.00 sec
3/6 Test #3: failure_at_k .....................   Passed    0.01 sec
4/6 Test #4: move_chain .......................   Passed    0.01 sec
5/6 Test #5: throwing_release .................   Passed    0.01 sec
6/6 Test #6: release_once .....................   Passed    0.01 sec
100% tests passed, 0 tests failed out of 6
```

ASan+UBSan 构建（`-fsanitize=address,undefined`）：6/6 通过。
注：本容器内 LeakSanitizer 因 ptrace 限制无法运行，已用
`ASAN_OPTIONS=detect_leaks=0` 关闭泄漏检测，其余内存错误与 UB
检查全部通过；释放次数正确性由测试中的释放轨迹断言直接验证。
