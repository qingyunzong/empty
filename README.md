# ORC stripe 谓词裁剪

批处理引擎需要可导入的 Go ORC stripe/row group 谓词评估库，支持三值逻辑、Bloom filter、timestamp 时区和 decimal 精度。统计缺失或截断时只能少裁不能误裁；组合 NOT/AND/OR 的 unknown 传播正确。小数据集逐行真值作为裁剪结果上界。
