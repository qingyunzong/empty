# Iceberg equality delete 类型绑定

Iceberg 扫描器需要可导入的 Go equality delete 规划组件，按 field id 而非名称绑定删除键，并考虑 delete/data sequence、分区 spec 演进和 null equality。类型提升使用表规则，无法安全转换则拒绝。结果与对每行应用可见删除文件的参考实现一致。
