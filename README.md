# dataeng - FTP 续传世代状态库

面向遗留数据采集服务的可嵌入 C++20 库。它不建立 FTP 连接，也不接管本地
文件写入；它只负责回答一个关键问题：

> 在发出 `REST <offset>` 之前，远端路径上的文件是否仍是本地 `.part` 文件
> 所属的那个世代？

## 为什么只看 SIZE/MDTM 不够

一个文件世代由四元组识别：

```
(远端路径, SIZE, MDTM, 已下载前缀 [0, offset) 的 SHA-256)
```

路径、SIZE、MDTM 完全相同并不代表内容相同。常见故障是文件 B 在一秒内被
重命名覆盖到文件 A 的路径上：两者 SIZE 相同，`MDTM` 只精确到秒，于是元数据
一模一样。如果直接 `REST offset` 续传，本地会得到 A 的前缀 + B 的后缀，
最终被标记为一次“成功”采集。

库把这种情况视为不同世代，并拒绝续传。

## 核心规则

`verify_resume(state, remote, options)` 依次检查：

1. 路径、SIZE、MDTM 必须与状态完全一致；
2. 如果提供了远端前缀摘要，它必须等于状态中的前缀摘要；
3. 当 MDTM 的有效粒度粗于 `VerifyOptions::max_trusted_mtime_resolution`
   （或设置了 `require_prefix_proof`）时，必须提供匹配的远端前缀证明。

有效粒度按“扩大冲突判定”的方式计算：

```
effective = max(state.mtime_resolution,
                observation.mtime_resolution)
          + options.mtime_conflict_margin
```

`effective` 大于可信阈值时，相同的时间戳不再足以证明同一世代；必须读取远端
前缀并比较摘要。默认只信任毫秒级 MDTM，因此普通整秒 MDTM 会强制做前缀证明。
如果服务器实际按 10 秒或 1 分钟取整，应把 `mtime_resolution` 设为相应值，
从而扩大需要额外证据的时间窗口。

任何路径/SIZE/MDTM 差异都是确定性冲突，即使前缀摘要仍然相同也不能续传，
因为相同的前缀无法证明尾部没有被替换。

## 典型流程

```cpp
#include "dataeng.hpp"

using namespace dataeng;
using namespace std::chrono_literals;

// 1. 首次采集：记录 SIZE、MDTM，并在读入字节时维护前缀摘要。
ResumeState state = ResumeState::fresh(remote_path, remote_size, remote_mtime, 1s);
PrefixDigest prefix;

// 每追加一块数据：
prefix.update(chunk);
state.advance(prefix.size(), prefix.hex_digest());
save_state_atomic(state_file, state);

// 2. 续传前：重新取 SIZE/MDTM，必要时通过 REST 0 + RETR 读取远端前缀。
RemoteObservation observed;
observed.path = remote_path;
observed.size = parse_size_reply(ftp_size_reply);
observed.mtime = parse_mdtm_reply(ftp_mdtm_reply);
observed.mtime_resolution = 1s;  // 或 mdtm_resolution(ftp_mdtm_reply)

ResumeDecision decision = verify_resume(state, observed);
if (decision.needs_prefix_proof) {
  const std::string remote_prefix = ftp_read_range(0, state.offset); // REST 0
  observed.prefix = PrefixProof{state.offset, sha256_hex(remote_prefix)};
  decision = verify_resume(state, observed);
}

if (!decision.can_resume()) {
  // 丢弃 .part，从 0 重新采集；绝不能把新数据追加到旧前缀后面。
  restart_from_zero();
} else {
  // 此时才允许 REST state.offset。
  ftp_rest(state.offset);
  append_remaining_bytes();
}
```

读取远端前缀是为了证明内容，不能把这段数据写入最终文件；读完前缀后，续传
仍需重新建立数据连接并再次 `REST state.offset`。

## 本地文件约束

续传前还必须验证本地 `.part` 文件本身：

```cpp
LocalPrefixCheck local = check_local_prefix(state, part_path);
if (!local.ok()) {
  // Short / Longer / DigestMismatch 都表示状态与本地文件不再对应。
  restart_from_zero();
}
```

库要求本地文件长度恰好等于 `state.offset`，并重新计算其前缀摘要。文件更长、
更短或摘要不符时都不能追加。

若进程重启后状态文件丢失，可先用 `capture_state_from_local()` 从现有 `.part`
重建状态：它以文件当前长度作为 offset，并计算其完整 SHA-256。该函数仍会拒绝
比远端 SIZE 更长的本地文件；重建之后依旧必须调用 `verify_resume()`。

## 完成与原子发布

`verify_completion()` 只接受 `offset == SIZE` 的状态，并再次执行同一套世代
校验。成功时返回不可伪造的 `CompletionProof`：

```cpp
// 对可能被并发改写的远端，建议对完整文件做证明：
observed.prefix = PrefixProof{
    state.size, sha256_hex(ftp_read_range(0, state.size))};

auto proof = verify_completion(state, observed, {.require_prefix_proof = true});
if (!proof) {
  // 远端已变化或证据不足：本次采集失败，删除 .part。
  fail_collection();
} else {
  // 重新校验 .part 的长度/摘要，fsync 后原子 rename 到最终路径。
  commit_completion(std::move(*proof), part_path, final_path);
}
```

`commit_completion()` 在发布前重新计算整个 `.part` 的摘要，因此校验之后发生
的本地损坏或并发追加也不会被当成成功采集。POSIX 上使用同目录临时文件 +
`rename()` 完成原子替换。

粗粒度 MDTM 下，`verify_completion()` 默认强制 `length == SIZE` 的远端前缀
证明，也就是完整远端内容摘要。这能发现续传期间发生的改名/覆盖，避免拼接结果
被发布。

## 状态文件

`encode_state()` / `decode_state()` 使用带版本和校验和的确定性文本格式：

- 路径按十六进制编码，可安全包含空格、换行和非 ASCII 字节；
- 校验和覆盖整个状态正文，截断或篡改会被拒绝；
- `save_state_atomic()` 在目标目录写入唯一临时文件后原子改名；
- `load_state()` 不会接受未知版本或无效不变量。

状态文件写入是原子的，但库不提供跨进程锁。多个采集进程同时处理同一路径时，
调用方应额外持有按路径的互斥锁。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试覆盖 SHA-256、MDTM 解析、状态编码/原子保存、粗时间粒度下的强制前缀证明、
同一秒内改名覆盖、本地前缀损坏、完成校验和原子发布。

## FTP 能力边界

FTP 没有标准的服务端哈希命令。库通过 `REST 0 + RETR` 读取远端前缀来获得内容
证据。若远端在尾部传输过程中持续被改写，且 SIZE/MDTM 与完整内容摘要都无法
区分，任何基于 FTP 的续传都无法绝对保证逐字节一致性；因此对并发写入的远端，
应在完成时使用完整文件证明（`length == SIZE`），而不是只依赖元数据。
