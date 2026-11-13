# Thrift framed 流多路归并

采集代理需要可嵌入 C++ Thrift framed 响应归并层，按 seqid、method 和 message type 配对并限制 frame 长度。oneway 不等待响应，exception 只终止对应调用；seqid 回绕且仍有在途请求时拒绝新调用。分片读取不得把相邻 frame 拼错。

## 组件

`dataeng::FramedMerger`（见 `dataeng.hpp` / `dataeng.cpp`）是一个无外部
依赖、可直接嵌入采集代理的 framed 响应归并层：

- `registerCall(method, type, out_seqid)` 登记外发调用并分配 seqid；
  `Oneway` 调用不进入在途表，因此永远不等待响应。
- `feed(data, size)` 接收任意分片字节，内部按 4 字节大端长度前缀重组
  TBinaryProtocol frame，支持单帧分片、多帧粘包，绝不跨 frame 边界拼接。
- 完整 frame 按 `(seqid, method, message type)` 三元组与在途调用配对，
  命中后通过回调投递 `MergedFrame`。
- `Reply` 与 `Exception` 都只结束各自的调用；exception 不影响其它在途请求。
- seqid 在 `[0, seqid_ceiling]` 内循环；回绕时若候选 seqid 仍被在途调用
  占用，新调用返回 `SeqIdInFlight`（即拒绝，而不是复用旧 seqid）。
- 长度前缀超过 `max_frame_bytes`（默认 16 MiB）返回 `FrameTooLarge` 并令
  流进入 failed 状态，需 `reset()` 后才能继续；配对类错误（未知 seqid、
  method 不符）为非致命，不影响后续 frame 解析。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试覆盖：乱序配对、逐字节分片、粘包/前缀截断、frame 长度限制、oneway、
exception 隔离、seqid 回绕拒绝、method/type 不匹配与畸形 frame。

## 线程模型

`FramedMerger` 非线程安全；跨线程使用时由调用方加锁。
