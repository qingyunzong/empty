# pcapng 多接口时间换算

流量数据入口需要可嵌入 C++ pcapng 时间归一组件，解析 section byte order、interface timestamp resolution/offset 和 enhanced packet block。每个 section 的 interface id 独立，未知 option 保留；时间用整数有理数换算，跨接口排序不丢原始 tick 与不确定精度。
