# Parquet byte stream split 向量解码

计算引擎要嵌入可嵌入的 C++ BYTE_STREAM_SPLIT 解码组件，支持 float/double/fixed-width、选择向量和页内跳过。lane 长度必须整除宽度；null 通过 definition level 对齐而不消费编码值。标量参考与 SIMD 路径逐位一致，包括 NaN payload。
