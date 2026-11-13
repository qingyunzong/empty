# Hudi MOR 日志块回滚

合并读取层要嵌入可嵌入的 C++ Hudi log scanner，按 instant、block sequence 和 header/footer 校验合并 data、delete、command block。rollback command 只影响匹配 target instant；损坏尾块可截断恢复，中央损坏停止。记录合并遵循 preCombine 顺序。
