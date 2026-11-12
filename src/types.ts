/**
 * 已解析文档树中的单个节点。
 */
export interface ArchiveNode {
  /** 全树唯一的节点 ID。 */
  id: string;
  /** 标签名，按调用方给定的字面值与允许改写列表精确比较。 */
  tag: string;
  /** 节点属性，键为属性名，值为原始字符串值。 */
  attributes: Record<string, string>;
  /** 子节点，按文档顺序排列。 */
  children: ArchiveNode[];
}

/**
 * 允许改写的标签属性对。
 */
export interface TagAttributePair {
  tag: string;
  attribute: string;
}

/**
 * 资源清单条目，按 URI 精确匹配。
 */
export interface ManifestEntry {
  /**
   * 资源的绝对 URI（http/https），按字面值与资源引用去片段后的
   * 解析结果精确匹配，因此清单条目本身不应携带片段。
   */
  uri: string;
  /**
   * 资源的本地归档路径。
   * 必须是无点段的相对路径，不得为绝对路径，也不得包含反斜杠。
   */
  localPath: string;
}

/**
 * 单次改写的输入。
 */
export interface RewriteInput {
  /** 已解析的文档节点树根节点。 */
  tree: ArchiveNode;
  /** 最终响应 URL，作为无有效 base 时的解析基准。 */
  responseUrl: string;
  /** 按 URI 精确匹配的资源清单。 */
  manifest: ManifestEntry[];
  /** 允许改写的标签属性对，不在列表中的属性保持原值。 */
  allowed: TagAttributePair[];
}

/**
 * 一次属性替换的记录。
 */
export interface Replacement {
  /** 被替换属性所属节点的 ID。 */
  nodeId: string;
  /** 被替换的属性名。 */
  attribute: string;
  /** 属性的原始值。 */
  originalValue: string;
}

/**
 * 改写结果。整棵新树与所有数组均被冻结，不可修改。
 */
export interface RewriteResult {
  /** 改写后的新文档树，输入树不会被修改。 */
  tree: ArchiveNode;
  /** 本次发生的全部替换，按深度优先文档顺序排列。 */
  replacements: Replacement[];
  /**
   * 未命中清单的资源记录：按文档顺序排列的去片段绝对 URI，
   * 每个未命中的属性引用各记一条（含重复）。
   * data: 与仅片段引用不记录。
   */
  missedUris: string[];
}
