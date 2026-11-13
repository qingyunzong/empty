# Service Worker 缓存旁路验证

页面数据采集要可直接接入 TypeScript 请求来源判定组件，区分网络、service worker、memory cache 与 disk cache 响应。任务可要求新鲜网络证据；此时先等待 SW 失控并创建新文档世代，再核对 response source，不能仅清理一个 cache 后宣称旁路成功。
