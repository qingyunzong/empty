# Iceberg 位置删除跨快照应用

湖仓读取层需要可导入的 Go Iceberg position delete 规划库，根据数据文件路径、行位置、sequence number 和 snapshot lineage，把多个删除文件精确应用到各 data file。删除文件不能作用于比自身序列更新的数据；分支快照只继承祖先可见项，路径规范化不得合并不同对象。输出按文件分组的有序删除区间，并以逐行参考执行验证可见记录。
