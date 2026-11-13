# 会话 cookie 分区采集

浏览器连接器需要可导入的 TypeScript cookie 快照库，表示 domain/path、SameSite、Secure、HttpOnly、partition key 和 expiry。导入快照前按目标 top-level site 筛选，不能把分区 cookie 降为普通 cookie；并发 Set-Cookie 按响应世代合并，过期删除不会被旧快照复活。
