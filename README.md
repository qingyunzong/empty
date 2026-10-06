# colcli — 列存整数查询 CLI

直接在游程编码（RLE）与位打包（bit-packed）块上执行整数比较过滤与聚合，
不做全量解码。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 用法

```sh
colcli write  <file> <rows> [seed]   # 生成随机列文件（混合 RLE / 位打包块）
colcli filter <file> <op> <value>    # 输出匹配的原始行号（升序）
colcli agg    <file>                 # rows=<总行数含 null> sum=<非 null 和>
colcli agg    <file> <op> <value>    # 过滤后的 count/sum
# op: = != < <= > >=
```

## 语义

- **过滤位置即原行号**：`filter` 输出的位置跨块连续编号，与原始行一一对应。
- **null 语义**：null 不匹配任何比较；不计入 sum，但计入全列 `agg` 的总行数。
- **无部分结果**：`read_column` 在返回前校验整个列（magic、版本、游程长度和、
  位宽、位图/打包数据尺寸、块行数总和、尾部垃圾），任何坏块都会使加载整体
  失败，CLI 以非零退出且不输出任何查询结果。

## 文件格式（小端）

```
magic "COLR" | u32 version=1 | u32 ncols=1
name: u32 len + bytes | u64 num_rows | u32 num_blocks
每块: u8 enc (1=RLE, 2=BitPack) | u32 rows
  RLE:     u32 nruns, 每游程: u8 is_null | i64 value | u32 length
  BitPack: u8 bit_width | u32 bm_len + null位图 | u32 pk_len + 打包数据
           （值 i 占比特 [i*w, (i+1)*w)，二进制补码，LSB 优先）
```

## 测试

- `engine_test`：100 组随机列（混合编码、随机 null、含 INT64_MIN/MAX 极值），
  对全部 6 种比较算子与随机阈值，将块上直接执行的 filter/agg 结果与逐行参考
  实现对照；另含空列、极值符号扩展、以及坏块（坏 magic、截断、游程长度不符、
  非法位宽、块行数溢出、尾部字节）必须整体报错且不发布部分结果的用例。
- CTest 另跑 CLI 端到端用例：生成 → 聚合/过滤 → 校验输出格式，以及损坏文件
  必须非零退出。
