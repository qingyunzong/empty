# robots 规则世代与抓取租约

多租户爬虫需要可导入的 Go robots 策略组件，按 scheme/host/port 缓存解析后的 user-agent 规则、抓取延迟和过期世代。任务领取时绑定策略版本；新规则可取消尚未发出的请求，但不能改写已完成证据。网络失败按配置 fail-open/closed 并可审计。
