# HTTP Link 分页循环

REST 连接器需要可导入的 TypeScript Link header 分页组件，正确解析 quoted-string、相对 URI、多 rel 和逗号歧义。next URL 规范化后纳入访问集合，循环返回路径；跨 origin next 按白名单拒绝。当前页落库确认后才提交下一链接恢复点。
