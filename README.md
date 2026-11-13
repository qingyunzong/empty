# 向量瓦片属性字典归并

地图数据入口需要可直接接入 Go MVT layer 归并库，重建 keys/values/tag 索引并合并多个 tile fragment。属性值类型不同不能仅按文本合并，geometry command 只在 extent 一致时拼接；输出字典按稳定排序重编号且所有 tag 引用有效。
