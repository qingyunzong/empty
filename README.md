# Arrow union 切片偏移重写

内存数据管线要嵌入可嵌入的 C++ Arrow dense/sparse union 切片库，联合 type id、child offset、父 offset 和有效长度生成零拷贝视图或安全重写。dense 子偏移越界立即失败；嵌套切片组合与一次切片等价，未引用 child 不得被误纳入。
