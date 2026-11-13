# 在线特征 TTL 与墓碑

在线特征服务需要可嵌入的 C++ 版本状态库，值带 event time、write version、TTL 和墓碑。迟到值不能复活更新墓碑；物理过期不改变历史 point-in-time 结果的证据。批量多特征写入原子可见，部分失败不发布。
