# ORC 行组谓词与时区统计

批数据读取器需要可导入的 Go ORC stripe/row-group 裁剪库，解析 row index、bloom filter、writer timezone 和 timestamp statistics，为等值、范围、IN 与 IS NULL 生成候选区间。旧 writer 的本地时间统计按声明版本解释，夏令时歧义时扩大候选而非误删；缺失或不可信统计返回 may-match。裁剪结果与逐行求值比较，要求零假阴性。
