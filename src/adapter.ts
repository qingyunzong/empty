import { compilePolicy, policyAllows, type CompiledPolicy } from "./policy.js";
import type { PolicyVerdict, ResourcePolicy, ResourceType } from "./types.js";
import {
  type OriginParts,
  effectivePort,
  normalizePath,
  parseOrigin,
  resolveTargetUrl,
} from "./url.js";

/**
 * Browser-facing hook: construct once per page with the page origin and the
 * active policies, then ask it whether a subresource may load. Policies are
 * compiled up front so the hot path during page loading only matches.
 */
export class PageLoadAdapter {
  private readonly page: OriginParts;
  private readonly compiled: CompiledPolicy[];

  constructor(
    private readonly pageOrigin: string,
    policies: ResourcePolicy[],
  ) {
    this.page = parseOrigin(pageOrigin);
    this.compiled = policies.map(compilePolicy);
  }

  canLoadScript(resourceUrl: string): PolicyVerdict {
    return this.canLoad(resourceUrl, "script");
  }

  canLoadImage(resourceUrl: string): PolicyVerdict {
    return this.canLoad(resourceUrl, "img");
  }

  canLoad(resourceUrl: string, type: ResourceType): PolicyVerdict {
    const url = resolveTargetUrl(resourceUrl, this.pageOrigin);
    const normalizedPath = normalizePath(url.pathname);
    const target = {
      url,
      normalizedPath,
      origin: {
        scheme: url.protocol.toLowerCase(),
        host: url.hostname.toLowerCase(),
        port: effectivePort(url),
      },
    };
    if (normalizedPath === null) {
      const deniedBy = this.compiled.map((_, index) => index);
      return { allowed: false, allowedBy: [], deniedBy };
    }

    const allowedBy: number[] = [];
    const deniedBy: number[] = [];
    this.compiled.forEach((policy, index) => {
      if (policyAllows(policy, type, target, this.page)) {
        allowedBy.push(index);
      } else {
        deniedBy.push(index);
      }
    });

    return { allowed: deniedBy.length === 0, allowedBy, deniedBy };
  }
}
