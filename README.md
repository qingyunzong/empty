# Arrow dictionary delta 世代

列式流接收器要可嵌入 C++ Arrow IPC dictionary 管理器，按 dictionary id、isDelta 与 record batch 顺序维护不可变世代。替换字典不能改变已排队 batch 的索引含义，delta 越界拒绝；多个字段共享 id 时类型必须一致。随机切块消息与完整流产生同一数组。
