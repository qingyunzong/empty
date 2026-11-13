# Barrier 对齐与非对齐快照

流引擎需要可嵌入 C++ checkpoint barrier 协调器，多输入算子可在对齐超预算时切换 unaligned。切换瞬间准确记录各 channel 在途缓冲，重复 barrier 幂等，旧 checkpoint barrier 不阻塞新世代。恢复后不漏不重，并保存模式切换证据。
