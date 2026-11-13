# Iceberg manifest 删除应用

湖仓扫描规划器会调用可导入的 Go Iceberg manifest 合并库，把 snapshot lineage、data file、position delete 与 equality delete 绑定到正确 sequence number。分区裁剪后仍不能丢失可能命中的 delete file；回滚快照不复用未来删除。小表逐行应用删除作参照。
