# Parquet 重复层级记录重建

Parquet 读取器需要可嵌入的 C++ repetition/definition level 重建库，把分片页流还原为嵌套 list、struct、map，区分 null 容器、空容器与 null 元素。记录跨页时保持层级状态；非法 level 序列给出最早位置。重建结果与公开的嵌套参考编码互逆。
