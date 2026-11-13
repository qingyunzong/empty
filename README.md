# Grace hash join 分区重试

查询引擎要嵌入可嵌入的 C++ Grace hash join 协调器，构建/探测两侧用相同分区世代，处理 null、外连接 unmatched 和递归溢写。分区失败可单独重试但不能重复输出已提交分区； skew fallback 保持原 join 语义。
