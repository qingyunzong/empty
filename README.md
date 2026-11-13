# MQTT retained 快照边界

IoT 采集服务要可直接接入 TypeScript retained 状态归并组件，在订阅启动时区分 retained 快照、实时发布、重复 QoS 传输和空 payload 删除。共享订阅与普通订阅分别建模；快照完成边界由调用方协议给出，不能靠等待时间猜测。
