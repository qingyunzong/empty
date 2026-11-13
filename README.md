# GraphQL subscription 去重水位

订阅采集服务要调用可导入的 TypeScript 连接状态库，协调 connection_ack、订阅 id、应用事件版本和 keepalive。重连重新订阅时旧 socket 的迟到事件失效；同版本不同内容视为冲突。水位在下游确认后推进，并生成可复核的重连与去重记录。
