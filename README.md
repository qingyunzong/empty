# WebSocket 增量快照重连

行情采集器需要可直接接入 TypeScript 快照增量协调器，根据频道 sequence、snapshot sequence 与 gap 检测建立一致状态。重连期间先缓存有界增量，快照到达后仅重放其后的连续序列；重复消息幂等，缓存溢出重新请求快照而不发布部分簿。
