# 跨域 iframe 消息配对

嵌入式表单采集需要可直接接入 TypeScript postMessage 配对组件，校验 origin、source window、nonce 与消息阶段，把 iframe 就绪、字段请求和完成回执组成事务。frame 导航后旧 nonce 失效；乱序、重复和迟到消息幂等处理，不能把同源其他 frame 的响应串入。
