# Parquet 页索引三态裁剪

列式扫描器需要可嵌入的 C++ Parquet page-index 裁剪组件，联合 column index、offset index、边界顺序、null page 与嵌套 repetition level 判断候选页。谓词对缺失统计返回 unknown 而非误删，截断 min/max 只能用于安全方向；多列 AND/OR 按三态集合组合。损坏索引明确回退整 row group，结果不得出现假阴性。
