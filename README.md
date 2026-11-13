# Parquet 页索引裁剪

查询引擎要可嵌入 C++ Parquet page index 裁剪组件，联合 ColumnIndex 的 min/max/null page、OffsetIndex 与列排序语义判断候选页。NaN、截断字符串统计和无序列不能产生假阴性；嵌套 repeated 列的 row range 按 first_row_index 合并，结果可由逐页扫描对照。
