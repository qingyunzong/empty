# Parquet delta binary packed 解码

列式读取层需要可导入的 Go DELTA_BINARY_PACKED 流解码库，处理 block/miniblock、zigzag delta、跨页状态和 int32/int64 溢出。值数与页 header 必须精确匹配；截断给出所需比特位置。分块输入与一次性解码结果及错误位置一致。
