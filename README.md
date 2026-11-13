# Avro schema resolution 精确默认值

消息入口需要可直接接入的 Go Avro schema resolution 组件，执行 writer/reader record、union、alias、numeric promotion 和默认值规则。默认值按 reader schema 类型解释，union 分支不得按名称猜测；递归 schema 用引用图避免无限展开。官方兼容样例与小 schema 穷举核对。
