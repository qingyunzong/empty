# EDIFACT UNA 动态语法

供应链采集器要可直接接入 C++ EDIFACT 解析库，支持 UNA 指定服务字符、release 转义、UNB/UNZ 与 UNH/UNT 计数。段终止符可跨块，被 release 的终止符属于数据；消息失败隔离到对应 UNT，interchange 计数仍按实际消息核对。
