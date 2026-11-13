# 推测执行胜者提交

批处理运行时需要可直接接入 Go speculative attempt 协调器，同一 task 可启动多个 attempt，但只有一个提交输出 manifest。胜者由首个完整且校验通过的条件写决定，其他 attempt 收到取消；迟到心跳和部分文件不能覆盖胜者。重启后从提交记录恢复同一选择。
