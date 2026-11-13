# Count-Min 重打击者候选

流量分析服务会调用可导入的 Go Count-Min heavy hitter 组件，在固定内存内维护估计计数与候选集。hash seed、宽深和衰减世代显式配置；合并只接受相同参数。候选漏报界限由总权重和误差参数验证，负更新仅在 strict turnstile 条件下允许。
