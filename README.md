# decimal 聚合溢出提升

分析引擎需要可导入的 Go decimal 聚合库，按 precision/scale 规则执行 sum、avg 和乘积中间态。分片合并使用足够宽精度，最终舍入模式公开；溢出、除零与 null 不得因合并顺序改变。返回值或确定错误与大整数参考模型一致。
