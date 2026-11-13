# 特征点时一致回填

特征平台需要可直接接入 Go point-in-time join 组件，为每个训练事实选择 event time 不晚于事实且 created time 不晚于训练快照的特征版本。TTL、回填修订和删除墓碑分别处理；同时间版本用 source sequence 裁决，避免未来信息泄漏。
