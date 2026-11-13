# Kinesis 聚合记录解包

流接入服务会调用可导入的 Go Kinesis 聚合记录解包组件，验证 protobuf magic、MD5、partition key 表和显式 hash key 索引。子记录保留父 sequence 与 subSequence，重放检查点精确到子记录；坏聚合包作为一个失败单元，不能部分确认。
