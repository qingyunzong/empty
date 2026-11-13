# 向量索引快照增删可见性

向量数据层需要可嵌入的 C++ 索引世代协调库，增量 add/delete 与后台 rebuild 并发。查询固定 base snapshot 加 delta 前缀；墓碑屏蔽旧向量。rebuild 追平水位后原子切换，失败不丢 delta，重复操作按向量版本幂等。
