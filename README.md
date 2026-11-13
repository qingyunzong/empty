# Protobuf unknown 字段迁移保留

数据迁移层要嵌入可嵌入的 C++ Protobuf 变换库，在旧新 descriptor 间映射字段，同时保留 unknown field、oneof 选择、presence 和扩展字段。字段号重用或 wire type 冲突必须拒绝；往返迁移后未触及的未知字节语义等价，并报告不可逆变化。
