# 压缩流可恢复块索引

归档采集器需要可嵌入 C++ gzip 多成员索引组件，扫描 deflate block 边界、成员 header/trailer 与未压缩偏移。只在可恢复字典状态处建 seek point，CRC/ISIZE 按成员验证；尾部截断保留完整成员索引并标记不完整，随机读取与顺序解压片段一致。
