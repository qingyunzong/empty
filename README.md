# HAR 页面请求归组

性能数据入口需要可直接接入 TypeScript HAR 归组组件，联合 pages id、startedDateTime、redirectURL、timings 和 vendor request id 重建导航请求树。时间区间矛盾保留原值并标记，缺 pageRef 的请求按因果证据归组或留孤立，不能只按最近时间猜测。
