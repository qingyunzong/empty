# 追踪 span 迟到闭合与修订

trace 接入层需要可导入的 Go span 组装库，处理父子乱序、重复、clock skew 和 tail-sampling 决定。trace 超时可先闭合不完整版本，迟到 span 生成修订世代；相同 span id 内容冲突隔离。采样决定绑定完整证据。
