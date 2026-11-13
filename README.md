# Thrift framed 流多路归并

采集代理需要可嵌入 C++ Thrift framed 响应归并层，按 seqid、method 和 message type 配对并限制 frame 长度。oneway 不等待响应，exception 只终止对应调用；seqid 回绕且仍有在途请求时拒绝新调用。分片读取不得把相邻 frame 拼错。
