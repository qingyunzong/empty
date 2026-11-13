# ORC bloom filter 版本兼容

ORC 规划器需要可导入的 Go BloomFilter/BloomFilterUtf8 解释库，按 writer version 和列类型选择 hash 语义。旧字符串过滤器在不安全类型上禁用；缺失、空位图和损坏 protobuf 分别处理。裁剪必须以逐行扫描证明零假阴性。
