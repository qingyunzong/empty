# 检查点保存点引用管理

流作业控制面需要可嵌入的 C++ checkpoint/savepoint 引用库，跟踪共享 state handle、增量父链和保留策略。删除检查点只回收无后代及无 savepoint 引用对象；并发完成与删除原子裁决。损坏引用图停止清理并返回路径。
