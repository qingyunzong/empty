# LZ4 frame 拼接限制

采集管线需要可导入的 Go LZ4 frame 解码协调器，支持独立/依赖 block、content size、dictionary id 和拼接 frame。字典由调用方按 id 提供且世代固定；每帧独立预算和 checksum，前帧失败不能把尾字节当下一 frame，合法 skippable frame 保留位置。
