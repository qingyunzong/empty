# Event Hubs epoch 所有权

遥测采集器需要可直接接入 TypeScript 分区所有权组件，协调 epoch receiver、ownership ETag 与 checkpoint。抢占成功后旧 epoch 的在途批次必须被拒绝提交；续租失败允许处理到当前批边界但不推进水位。用可控存储枚举两工作者竞争。
