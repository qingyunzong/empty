# SNMP counter wrap 与设备重启

网络采集器需要可嵌入的 C++ SNMP counter 速率组件，联合 sysUpTime、engineBoots、Counter32/64 和采样时刻识别回绕、重启与乱序。只有连续同世代样本计算速率；缺失区间不插值。时钟异常返回证据而非负速率。
