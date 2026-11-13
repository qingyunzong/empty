# SSO 重定向流程边界

企业 RPA 登录协调器要可直接接入 TypeScript SSO 导航状态机，根据允许的 issuer、redirect origin、state 与页面世代判断登录完成。多 IdP 选择和 MFA 人工步骤可暂停；意外跨域、state 变化或返回旧标签页立即隔离。组件不接触密码值，只输出下一动作与证据。
