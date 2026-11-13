# OpenTelemetry trace 补链

链路数据管线需要可导入的 Go trace 补链库，把乱序 span、link、resource 和 scope 归并为版本化 trace。相同 span id 内容冲突隔离，缺父 span 不阻塞超时发布但标记根因；迟到父节点到达后生成修订事件而非重发整条 trace。
