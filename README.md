# MySQL binlog 行镜像补全

MySQL CDC 层需要可嵌入的 C++ binlog 组装库，处理 table-map、row event、minimal row image、GTID 与事务 payload。缺列以 unknown 保留，不能当 null；table id 重用按文件位置分世代。校验失败阻止位点推进，已完整前序事务仍可交付。
