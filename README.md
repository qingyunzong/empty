# Delta Lake deletion vector 合并

湖仓扫描层需要可导入的 Go deletion vector 应用库，解析内联或外部位图、基数和 data file 唯一标识。多个提交对同文件的向量按快照谱系组合，不能作用于替换文件。损坏向量阻止该文件读取，输出可见行与逐位置参考模型一致。
