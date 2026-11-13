# EDI X12 控制号对账

交换数据入口要可嵌入 C++ X12 envelope 状态机，从固定 ISA 推导分隔符，校验 ISA/IEA、GS/GE、ST/SE 控制号和声明计数。功能组可跨传输块，重复 interchange 按 sender+control 去重；局部 transaction 失败不掩盖 envelope 级错误，并输出层级证据。
