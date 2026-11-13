# ORC 字典切换条带解码

ORC 扫描层需要可导入的 Go 字符串流解码组件，处理 stripe 内 dictionary/direct 编码、present/data/length 流和 row group seek。编码切换时重置对应状态但保留行号；缺流仅在全 null 情况合法。随机 seek 后结果须与从 stripe 起点顺序解码相同。
