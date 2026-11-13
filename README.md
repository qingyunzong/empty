# JDBC 类型元数据世代

通用数据库源需要可直接接入 Go 列元数据归一库，根据 JDBC type、precision、scale、signed、timezone 和 vendor type 生成内部 schema。结果集进行中 schema 快照不变；下一查询发现变化形成新世代。无符号大整数和带时区时间不得静默降精度。
