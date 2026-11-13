# Parquet 列页谓词证明

列式扫描器需要可嵌入的 C++ page pruning 组件，联合 row-group statistics、page index、dictionary 与 bloom filter 判断谓词是否可能命中。必须正确处理 null、NaN、截断字符串边界和旧写入器缺失元数据；任何不确定情况都保守读取。返回逐页裁决证据，并用解码后逐行过滤作为随机差分基准证明不会漏行。
