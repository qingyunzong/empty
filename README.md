# Kinesis 聚合记录子序号水位

Kinesis 入口需要可导入的 Go KPL 聚合记录解码与检查点库，验证 protobuf 摘要，把一个 sequence number 展开为多个 sub-sequence。部分子记录失败时水位停在精确子序号；重取父记录只重放未确认后缀，分片结束前必须清空待决项。
