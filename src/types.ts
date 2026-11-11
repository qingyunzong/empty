/**
 * Resource types that a policy can govern.
 */
export type ResourceType = "script" | "img";

/**
 * The directive buckets carried by a single policy object. Every bucket is
 * optional: a missing resource bucket falls back to `default`, and when both
 * the resource bucket and `default` are missing the policy places no
 * restriction on that resource type.
 *
 * Each bucket is a list of source expressions. Within one bucket the sources
 * are combined with OR (union). `'none'` is only valid as the sole entry.
 */
export interface ResourcePolicy {
  default?: SourceExpression[];
  script?: SourceExpression[];
  img?: SourceExpression[];
}

/**
 * A source expression is one of:
 *  - the keyword `'none'` (must be the only item in its bucket);
 *  - the keyword `'self'`, matching the page origin;
 *  - a bare scheme such as `'https:'`;
 *  - a host source such as `'example.test'`, `'*.example.test'`,
 *    `'https://example.test:8443/app'` or `'http://*.cdn.test/assets'`.
 */
export type SourceExpression = string;

/**
 * The verdict returned for a single evaluation. `allowedBy` / `deniedBy` hold
 * the indices (into the supplied policy array) of the policies that allow or
 * deny the resource. `allowed` is true only when every policy allows the
 * resource, i.e. when `deniedBy` is empty.
 */
export interface PolicyVerdict {
  allowed: boolean;
  allowedBy: number[];
  deniedBy: number[];
}
