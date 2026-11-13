# Arrow 字典数组跨批统一

列式交换层需要可嵌入的 C++ Arrow 字典统一组件，接收多批 dictionary、index、null bitmap 和 ordered 标志，生成全局字典与重映射索引。增量 delta 字典必须基于正确前代；索引溢出时升级位宽。稳定模式保持首次出现顺序，结果与解码后逐值比较一致。
