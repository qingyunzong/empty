# CDP Fetch 拦截正文归档

浏览器采集代理需要可导入的 TypeScript CDP Fetch 拦截协调器，把 paused request、network request id、redirect hop、response stage 与 body stream 绑定到唯一导航世代。每个暂停事件只能 continue、fulfill 或 fail 一次；页面取消时关闭未消费流，正文摘要和响应元数据完整落库后才确认采集记录。
