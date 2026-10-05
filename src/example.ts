import { del, NamedLayer } from "./merge";

/**
 * 示例三层配置，覆盖全部规则：
 *  - server.host / limits.cpu：仅 L1 定义（新增）
 *  - server.port / limits.mem：标量覆盖
 *  - server.tls：L1→L2 对象递归合并，L3 整体删除（墓碑）
 *  - plugins：按 id 合并（cache）、新增（metrics）、删除存在的项（auth）、
 *    删除 L2 自身不存在的项（phantom，墓碑保留以遮蔽 L1）
 *  - features：无 id 数组整组替换
 *  - mode：类型变化 string → object，整项替换
 *  - extra：新增 null
 */
export const exampleLayers: NamedLayer[] = [
  {
    name: "L1-base",
    config: {
      server: { host: "0.0.0.0", port: 80, tls: { enabled: false } },
      plugins: [
        { id: "auth", weight: 1, options: { sso: false } },
        { id: "cache", ttl: 300 },
        { id: "phantom", note: "将被高层删除" },
      ],
      features: ["alpha", "beta"],
      mode: "legacy",
      limits: { cpu: 2, mem: "512m" },
    },
  },
  {
    name: "L2-env",
    config: {
      server: { port: 8080, tls: { enabled: true, cert: "/etc/cert.pem" } },
      plugins: [
        { id: "cache", ttl: 600, backend: "redis" },
        { id: "metrics", port: 9090 },
        { id: "phantom", ...del() },
      ],
      mode: { strategy: "adaptive" },
      limits: { mem: "1g" },
    },
  },
  {
    name: "L3-local",
    config: {
      server: { tls: del() },
      plugins: [{ id: "auth", ...del() }],
      features: ["gamma"],
      extra: null,
    },
  },
];
