# eBPF ring buffer 丢失记账

内核事件采集器需要可直接接入 C++ ring buffer 消费状态库，把每 CPU sequence、lost counter、时间戳和 schema version 归并为全局事件流。CPU 热插拔开启局部世代；发现缺口生成显式 loss 事件，不能用后续记录填补。并列时间按稳定键排序。
