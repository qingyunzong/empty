# Flink checkpoint barrier 对齐

流处理运行时需要可导入的 Go barrier 对齐组件，为多输入算子缓存 barrier 后数据，支持 aligned、unaligned checkpoint 和取消标记。相同 checkpoint 只完成一次；后来的取消不能撤销已提交快照。通道恢复顺序须保证重放输出与无故障执行一致。
