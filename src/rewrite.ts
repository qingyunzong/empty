import type {
  ArchiveNode,
  ManifestEntry,
  Replacement,
  RewriteInput,
  RewriteResult,
} from "./types.js";

/**
 * 整页改写无法完成时抛出。抛出前不会修改输入树，也不会返回任何改写结果。
 */
export class ArchiveRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveRewriteError";
  }
}

function parseHttpUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArchiveRewriteError(`${what} 不是合法 URI: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ArchiveRewriteError(`${what} 不是 HTTP/HTTPS 资源: ${value}`);
  }
  return url;
}

/**
 * 校验清单本地路径：必须是非空、无反斜杠、无点段的相对路径。
 */
function validateLocalPath(localPath: string): void {
  if (localPath === "") {
    throw new ArchiveRewriteError("清单本地路径不能为空");
  }
  if (localPath.startsWith("/")) {
    throw new ArchiveRewriteError(`清单本地路径不能是绝对路径: ${localPath}`);
  }
  if (localPath.includes("\\")) {
    throw new ArchiveRewriteError(`清单本地路径不能包含反斜杠: ${localPath}`);
  }
  for (const segment of localPath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ArchiveRewriteError(
        `清单本地路径必须是无点段的相对路径: ${localPath}`,
      );
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value as object)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

interface BaseResolution {
  base: URL;
  baseNodeId: string | null;
}

/**
 * 深度优先文档顺序完整遍历：校验节点 ID 唯一，并记录首个 base 节点。
 * 无 base 或 base 无 href 时使用最终响应 URL；后续 base 节点一律忽略。
 */
function resolveBase(
  node: ArchiveNode,
  responseUrl: URL,
  seenIds: Set<string>,
  state: BaseResolution,
): void {
  if (seenIds.has(node.id)) {
    throw new ArchiveRewriteError(`节点 ID 重复: ${node.id}`);
  }
  seenIds.add(node.id);

  if (
    state.baseNodeId === null &&
    node.tag === "base" &&
    Object.hasOwn(node.attributes, "href")
  ) {
    const href = node.attributes.href;
    if (href === undefined) {
      throw new ArchiveRewriteError(`base 节点 ${node.id} 的 href 非法: ${href}`);
    }
    let base: URL;
    try {
      base = new URL(href, responseUrl);
    } catch {
      throw new ArchiveRewriteError(
        `base 节点 ${node.id} 的 href 非法: ${href}`,
      );
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new ArchiveRewriteError(
        `base 节点 ${node.id} 的 href 不是 HTTP/HTTPS: ${href}`,
      );
    }
    state.base = base;
    state.baseNodeId = node.id;
  }

  for (const child of node.children) {
    resolveBase(child, responseUrl, seenIds, state);
  }
}

interface RewriteContext {
  base: URL;
  manifest: Map<string, string>;
  allowed: Set<string>;
  replacements: Replacement[];
  missedUris: string[];
}

function rewriteNode(node: ArchiveNode, context: RewriteContext): ArchiveNode {
  const attributes: Record<string, string> = { ...node.attributes };

  for (const [attribute, rawValue] of Object.entries(node.attributes)) {
    if (!context.allowed.has(`${node.tag}\u0000${attribute}`)) {
      continue;
    }

    // data: 与仅片段引用保持原值，不查清单也不记未命中。
    if (rawValue.startsWith("data:") || rawValue.startsWith("#")) {
      continue;
    }

    let resolved: URL;
    try {
      resolved = new URL(rawValue, context.base);
    } catch {
      throw new ArchiveRewriteError(
        `节点 ${node.id} 的属性 ${attribute} 不是合法 URI: ${rawValue}`,
      );
    }

    // 从原始值提取片段，确保空片段（"#"）与原始写法原样保留。
    const hashIndex = rawValue.indexOf("#");
    const fragment = hashIndex === -1 ? "" : rawValue.slice(hashIndex);
    resolved.hash = "";
    const lookupUri = resolved.href;
    if (!context.manifest.has(lookupUri)) {
      // 未命中：保留原值，记录去片段后的绝对 URI。
      context.missedUris.push(lookupUri);
      continue;
    }

    const localPath = context.manifest.get(lookupUri) as string;
    attributes[attribute] = localPath + fragment;
    context.replacements.push({
      nodeId: node.id,
      attribute,
      originalValue: rawValue,
    });
  }

  const children = node.children.map((child) => rewriteNode(child, context));
  return { id: node.id, tag: node.tag, attributes, children };
}

/**
 * 将文档树中允许改写的资源引用重写为本地归档路径。
 *
 * 任何待处理非法 URI、非法 base 或非法清单条目都会抛出
 * {@link ArchiveRewriteError}，此时输入树保持不变，且不返回改写结果。
 */
export function rewriteArchiveLinks(input: RewriteInput): RewriteResult {
  const responseUrl = parseHttpUrl(input.responseUrl, "最终响应 URL");

  // 先完成全部校验与解析，再构造新树，保证失败时输入树不被修改。
  const manifest = new Map<string, string>();
  for (const entry of input.manifest) {
    validateLocalPath(entry.localPath);
    parseHttpUrl(entry.uri, "清单 URI");
    manifest.set(entry.uri, entry.localPath);
  }

  const allowed = new Set(
    input.allowed.map((pair) => `${pair.tag}\u0000${pair.attribute}`),
  );

  const baseState: BaseResolution = { base: responseUrl, baseNodeId: null };
  resolveBase(input.tree, responseUrl, new Set(), baseState);
  const { base } = baseState;

  const context: RewriteContext = {
    base,
    manifest,
    allowed,
    replacements: [],
    missedUris: [],
  };

  const tree = rewriteNode(input.tree, context);

  return deepFreeze({
    tree,
    replacements: deepFreeze(context.replacements),
    missedUris: deepFreeze(context.missedUris),
  });
}
