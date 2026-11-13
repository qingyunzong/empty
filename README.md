# LSM compaction 重叠输入验证

状态存储需要可嵌入的 C++ compaction 提交库，计划绑定 level 文件集合和版本。输出 key range 必须覆盖输入且内部有序；提交时验证输入仍活跃、无重叠计划先提交。失败输出列入回收清单，不能进入 manifest。
