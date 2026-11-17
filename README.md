# dlks_formal

可嵌入的 C++20 异步 I/O 运行时组件(header-only,无外部依赖),
处理提交、取消、超时与完成乱序竞争。

## 组件

`dlks_formal::async_io_runtime`(见 `include/dlks_formal/async_io.hpp`):

- **提交**:`submit(callback)` / `submit(callback, deadline)` 返回
  `io_handle`(槽位下标 + 代次);容量固定,耗尽抛 `std::length_error`。
- **取消 / 完成**:`cancel(h)` / `complete(h, value)` 触发终态迁移;
  句柄失效时返回 `false`。
- **超时**:`advance_clock(now)` 推进逻辑时钟,收割到期请求;
  相同截止时间按槽位下标打破并列,顺序确定。
- **乱序竞争**:终态迁移时槽位立即回收并递增代次,旧句柄上的
  迟到完成/取消/超时因代次失配被拒绝,不会唤醒复用槽位上的新请求。
- **恰好一次**:回调在终态迁移时移入就绪队列,由 `run()` 调用
  恰好一次;`drain()` 与析构保证所有回调在对象销毁前排空。

## 验证

`tests/async_io_test.cpp` 以确定性事件排列验证不变量:

- 3 请求 × {complete, cancel} + 时钟推进共 7 事件的全部 5040 种排列,
  逐一校验终态唯一(由首个触及事件决定)与回调恰好一次;
- 槽位复用下的陈旧句柄探测、析构前排空、同种子压力测试的
  逐位确定性(20000 次交错操作);
- 测试默认以 ASan/UBSan 构建,检查无悬挂访问。

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
ctest --test-dir build --output-on-failure
```

注:在禁用 ptrace 的沙箱环境中 LeakSanitizer 不可用,构建系统会
自动探测并仅为测试关闭泄漏检查(ASan/UBSan 其余检查保留)。
