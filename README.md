# Iceberg manifest 继承字段解析

元数据读取层需要可嵌入的 C++ Iceberg manifest 解析库，正确处理 manifest list 继承的 snapshot id、sequence number、分区摘要和 v1/v2 缺省。字段缺失与显式 null 区分；状态码决定 entry 可见性。损坏计数不用于裁剪并返回诊断。
