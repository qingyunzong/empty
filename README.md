# deltaupd — 可恢复、可校验、原子发布的增量更新工具

从**大基线文件 + 增量流**恢复目标文件。更新过程可在任意指令边界中断并
继续；只有全部块哈希与最终总哈希都通过后才原子替换目标文件，错误结果
永远不会发布给用户。仅使用 Python 3.11 标准库。

## 更新流格式

```
MAGIC "GUPD1\n" | 基线指纹 (SHA-256, 32B) | 块数 (varint)
每块:  声明输出长度 (varint) | 块输出 SHA-256 (32B) | 指令序列 | END_BLOCK
末尾:  全量输出 SHA-256 (32B)
```

指令（`deltaupd/decoder.py`）：

| 操作码 | 指令       | 参数                    | 语义 |
|--------|------------|-------------------------|------|
| 0x01   | ADD        | len + len 字节字面量     | 追加字面字节 |
| 0x02   | COPY_BASE  | offset, len             | 从基线文件拷贝 |
| 0x03   | COPY_OUT   | distance, len           | 从已产生输出逐字节拷贝；允许重叠（len > distance 时按逐字节语义复制模式） |
| 0x00   | END_BLOCK  | —                       | 块结束，校验长度与块哈希 |

整数一律使用**有界规范 varint**（LEB128，≤63 bit，≤9 字节，必须最小编码；
`deltaupd/varint.py`）。超长 varint 报 `LengthOverflowError`，非最小编码报
`NonCanonicalVarintError`。

## 关键性质

- **任意字节分片**：`Decoder.feed()` 接受任意切片，每次返回已完成事件
  （带已验证指令边界的流偏移）和完成当前记号所需的剩余字节数；畸形输入
  立即抛出确定错误。
- **64 KiB 内存窗口**：`OutputSink`（`deltaupd/sink.py`）只在内存保留最近
  一个窗口的输出，更早的输出写入临时文件并按需随机读取；基线同样只经
  定位读取，从不整体装入内存。
- **检查点与恢复**：每个已验证指令边界后落盘检查点（输入偏移、输出长度、
  滚动哈希状态、块上下文、解码器相位，`state_dir/checkpoint.json`）。恢复
  时先重新校验基线指纹与临时输出前缀哈希，再截断临时文件到检查点长度、
  从输入偏移处继续。篡改基线 → `FingerprintMismatchError`；篡改/截断临时
  文件 → `CheckpointError`。
- **原子发布**：所有块哈希与最终总哈希通过后才 `os.replace` 临时文件到
  目标；任何失败都不触碰已有目标文件。
- **精确错误区分**：`LengthOverflowError`（长度溢出）与
  `CopyOutOfRangeError`（复制未生成区间）是不同异常类型；
  `BlockLengthExceededError` 在写入前抛出，异常指令不会扩大输出。

## 使用

```bash
# 生成增量流（离线工具，可装载输入）
python3.11 -m deltaupd encode --baseline old.bin --target new.bin --output upd.bin

# 应用（可中断/恢复；结果以 JSON 打印到 stdout）
python3.11 -m deltaupd apply --baseline old.bin --update upd.bin \
    --target new.bin --state-dir state/
# 输出: {"status": "applied", "output_length": N, "sha256": "..."}
# 输入不完整: {"status": "need_more", "needed": K, ...}（退出码 0）
# 失败: {"status": "error", "error_type": "...", "error": "..."}（退出码 1，目标不变）
```

库接口见 `deltaupd/__init__.py`：`Applier`（窗口化可恢复执行器）、
`Decoder`（增量解码器）、`interpret`（独立内存解释器/预言机）、
`build_update` / `encode_stream`（流构造）、`Sha256`（可序列化状态）。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖：短输出上窗口化执行器与独立内存解释器交叉核对（重叠拷贝、跨窗口
拷贝、嵌套复用）；枚举所有输入二分切分点；枚举所有检查点中断点并验证
恢复结果与一次性执行一致；篡改基线/临时文件拒绝；各类失败下已有目标
不变；SHA-256 与 hashlib 全边界对照；varint 规范性/溢出。

实测结果（Python 3.11.16）：**65 个测试全部通过（OK）**。
