# deltaup — 可断点续传的增量更新库

从基线文件与增量流恢复目标文件。纯 Python 3.11 标准库实现，无第三方依赖。

## 流格式

```
header  := MAGIC(8) baseline_len(varint) baseline_sha256(32) block_count(varint)
block   := out_len(varint) block_sha256(32) instr_len(varint) instr_bytes
instr   := 0x01 len(varint) payload               (ADD:       写入字面量)
         | 0x02 offset(varint) length(varint)     (COPY_BASE: 复制基线区间)
         | 0x03 offset(varint) length(varint)     (COPY_OUT:  复制已产生输出)
trailer := total_out_len(varint) total_sha256(32)
```

- 整数一律使用**有界规范 varint**（无符号 LEB128，最多 9 字节 / 63 位，
  禁止前导零填充的非最短编码）。
- `COPY_OUT` 允许重叠，语义为**逐字节前向复制**：只要求起始偏移小于
  当前已产生输出长度，复制过程中新产生的字节可立即被再次引用。
- 每个块携带输出长度与 SHA-256；全部块与最终总哈希都验证通过后，
  才通过 `os.replace` **原子替换**目标文件。任何失败都不会触碰已有目标。

## 流式解码

`deltaup.decoder.Decoder` 是推送式状态机：输入可按任意字节边界分片喂入，
每次 `feed` 返回完成当前解析单元**还需要的字节数**（流结束时为 0）；
确定性错误（非法魔数/操作码、非规范 varint、指令越出块边界等）立即抛出。
ADD 负载以 `add_begin/add_data/add_end` 事件透传，内存占用与负载大小无关。

## 内存窗口与临时文件

应用器只在内存中保留最近 64 KiB 输出（`window_size` 可调）；更早的输出
写入目标目录下的临时文件，通过 `os.pread/os.pwrite` 随机访问。基线文件
同样只做分块随机读，从不整体装入内存。

## 检查点与恢复

每处理完一条已验证指令边界，就原子地写入检查点（JSON），内容包括：

- 输入偏移（已验证指令边界对应的流偏移）
- 输出长度与滚动 CRC32 校验状态
- 解码器相位、块内剩余指令字节数、当前块期望哈希等

恢复时先**验证基线指纹**（长度 + SHA-256）与**临时输出前缀**
（长度 + CRC32），再从检查点记录的输入偏移继续处理剩余流。
篡改基线或临时文件会被拒绝，且已有目标文件保持不变。

## 错误区分

- `LengthOverflowError`：varint 超界/非规范、指令产出超过块声明长度等。
- `CopyFromUngeneratedError`（子类 `CopyBaseOutOfRangeError` /
  `CopyOutUngeneratedError`）：复制了尚未生成或不存在的区间。
- 异常指令在写入前完整校验，**不会扩大输出**。

## CLI（JSON 输出）

```sh
python3.11 -m deltaup encode --baseline old.bin --target new.bin --out diff.dupd
python3.11 -m deltaup apply  --baseline old.bin --delta diff.dupd --target new.bin
python3.11 -m deltaup resume --baseline old.bin --delta diff.dupd \
    --target new.bin --checkpoint .new.bin.ckpt
```

成功打印 `{"ok": true, ...}`；失败打印
`{"ok": false, "error_type": ..., "error": ...}` 并以状态 1 退出。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

覆盖：varint 边界与规范性；枚举所有输入切分点验证解码一致性；
与独立内存解释器核对重叠拷贝、跨窗口拷贝、嵌套复用；枚举所有
检查点中断点验证恢复结果与一次性应用一致；篡改基线/临时文件拒绝；
失败时已有目标不变；CLI 端到端。
