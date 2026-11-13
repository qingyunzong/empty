# 动态过滤器生命周期

分布式 join 需要可导入的 Go dynamic filter 状态组件，构建端分片提交 domain，协调 complete、timeout 和取消。过滤器未闭合时扫描端只能用安全的增量界；late domain 不能误删已规划 split。最终过滤器按快照广播并带完整性状态。
