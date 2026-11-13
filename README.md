# Arrow IPC 字典替换语义

Arrow IPC 接入层需要可嵌入的 C++ stream reader，处理 schema、dictionary batch、delta 标志、record batch 和 continuation marker。非 delta 字典替换后旧 batch 仍引用旧世代；新 batch 绑定新字典。未知 dictionary id 与错误 buffer 对齐须在交付前失败。
