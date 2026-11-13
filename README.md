# 浏览器请求导航世代归属

浏览器采集框架需要可导入的 TypeScript 导航归属组件，把 request、redirect、frame detach、same-document navigation 与 lifecycle 事件绑定到唯一文档世代。迟到响应不能写入新页面结果；子 frame 独立换页时只撤销其后代。事件乱序重放必须得到相同请求树。
