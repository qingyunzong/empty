# Zstandard seekable frame 读取

对象读取层需要可嵌入 C++ seekable Zstandard 索引库，解析 skippable seek table、frame compressed/decompressed size 与 checksum。索引条目总和须与实际 frame 边界一致，范围查询只解压必要 frame；损坏索引不回退为不受限扫描。
