# Avro 解析 schema 引用闭包

事件解码服务需要可导入的 Go Avro schema 解析库，从 registry id 构建命名类型与引用闭包，处理 namespace、alias、union default 和递归记录。缓存按内容指纹隔离；引用版本变更不能污染旧解码。返回 writer-reader resolution 计划及首个不兼容路径。
