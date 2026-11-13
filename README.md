# MapReduce shuffle 分区校验

批执行框架需要可嵌入 C++ shuffle segment 读取库，验证 partition index、segment offset/length、压缩块与校验和。单个 map 输出损坏只重取该来源，不能返回部分 reduce group；相同 key 跨 segment 的值按 map id 和记录序稳定归并。
