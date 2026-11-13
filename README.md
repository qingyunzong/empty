# HyperLogLog 世代合并

指标管线需要可导入的 Go HLL++ 状态库，支持 sparse/dense 表示、不同 precision 输入和显式 hash seed。只有 seed 相同的 sketch 可合并；降 precision 按寄存器映射进行，不能升精度伪造信息。序列化稳定，合并满足交换结合且误差用固定数据集验证。
