# 倒排索引删除世代

索引构建器需要可嵌入 C++ segment 删除状态库，以 doc id、segment generation 和 delete generation 管理 bitset。merge 只携带在其快照可见的删除，期间新删除重映射到输出 segment；旧 generation 回执不能覆盖新 bitset。逐文档可见性与参考模型一致。
