# Parquet bloom filter 安全裁剪

扫描器需要可嵌入的 C++ Parquet Bloom filter 组件，验证 header、算法、hash 和 bitset 长度，再为等值与 IN 谓词给出 may-match。类型物理编码、decimal 和 fixed binary 必须一致；不支持或损坏时回退，不得产生假阴性。
