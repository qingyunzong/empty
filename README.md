# SNMP GetBulk 表遍历

网络采集器需要可导入的 Go SNMP 表遍历库，处理多列 OID、non-repeaters、max-repetitions、endOfMibView 和代理返回越界 OID。每列独立推进且整体行按索引对齐；OID 不递增时终止对应列，重复响应幂等，稀疏列保留空值来源。
