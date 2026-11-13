# 固定宽度记录版本识别

主机数据接入层需要可直接接入 Go 固定宽度记录解码库，根据记录长度、版本判别字段和 EBCDIC code page 选择 schema。packed decimal、overpunch 与空白填充值分别验证；坏记录保留原偏移并隔离，跨块时不得按 UTF-8 字符数切字节。
