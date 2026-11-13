# MySQL binlog row image 补全

数据管道要可直接接入 Go binlog 归一化库，处理 TABLE_MAP 世代、MINIMAL row image、unsigned 类型、JSON partial update 与 transaction payload。缺列通过版本化前镜像补全，镜像不存在时标记不可重建而非填零；DDL 使旧表映射立即失效。
