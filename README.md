# Temporal table 版本查询

数据管道要可直接接入 Go temporal lookup join 状态组件，维表变更以 valid_from 和 source sequence 形成不可重叠版本。事实事件按自身事件时间选择当时版本，迟到维表可修订尚未封闭结果；同起点冲突必须隔离。查询与压缩后历史结果一致。
