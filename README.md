# NetFlow template 世代解码

网络流采集器需要可导入的 Go NetFlow/IPFIX template 状态库，按 exporter、observation domain、template id 和接收世代解析 data set。模板刷新只影响后续包，过期模板不猜字段；option template 独立管理。无模板数据进入有界等待区，匹配后按原接收序交付。
