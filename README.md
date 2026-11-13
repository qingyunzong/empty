# Avro object container sync 恢复

文件采集器需要可导入的 Go Avro OCF 流读取库，验证 header metadata、codec、block count/size 和 sync marker。块损坏时只在同时匹配 marker 与可解析下一块的位置恢复；负 count/size 拒绝。恢复报告丢失字节范围，前后完整块保持原顺序。
