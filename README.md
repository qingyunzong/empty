# 推测执行 attempt 胜者

批处理运行时需要可导入的 Go speculative attempt 协调库，同一 task 多 attempt 竞争输出 manifest。首个完整且校验通过的条件提交成为胜者，其他收到取消；迟到心跳和部分文件不能覆盖。重启从提交记录恢复同一选择。
