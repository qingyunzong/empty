# Bloom filter 分区裁剪合并

湖仓元数据层需要可嵌入 C++ blocked Bloom filter 库，格式固定 hash、salt、block selection 和 bit endianness。只合并参数完全相同的过滤器，序列化跨平台一致；过滤器用于裁剪时绝不产生假阴性。用已插入值、未插入值和损坏尾块核对。
