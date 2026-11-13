# As-of join 容差与并列

时间序列服务要可直接接入 TypeScript as-of join 组件，对每个左事件选择同 key 下不晚于它且在 tolerance 内的右版本。右侧相同时间按 source sequence 并列裁决，乱序输入先在有界水位内排序；封闭后迟到右值不得改写旧结果。
