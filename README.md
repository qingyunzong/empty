# Parquet definition level 重建

湖仓读取器需要可直接接入 C++ Dremel level 重建库，根据嵌套 schema、repetition/definition levels 和 value stream 生成 list/struct/null。空列表、空元素、null 列表必须可区分；非法 level 序列在消费越界前报当前位置。用小 schema 枚举所有合法结构做往返验证。
