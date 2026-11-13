# Arrow dense union 切片

内存执行引擎需要可直接接入 C++ Arrow dense/sparse union 切片组件，验证 type id 到 child 映射、offset 范围和 null 语义。切片后 dense offset 可保留原基址但访问不得越界；concat 时重写 offset 并保持未知扩展元数据。用逐元素解释器核对结果。
