# 查询 stage 重试输出去重

分布式查询协调器要接入可导入的 TypeScript stage attempt 状态库，跟踪 task、partition、output token 与下游消费前缀。stage 重试后旧 attempt 输出可继续读到已确认边界，但新输出不得重复这些页。提交与取消竞争产生唯一 winner。
