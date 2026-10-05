/** 源码片段映射：解码后文本 text 对应原始输入的 [start, end) 偏移。 */
export interface Segment {
  text: string;
  start: number;
  end: number;
}

export interface TextEvent {
  type: 'text';
  /** 实体解码后的文本。 */
  text: string;
  /** 解码文本到原始输入偏移的映射，按顺序拼接即为 text。 */
  segments: Segment[];
  start: number;
  end: number;
}

export interface OpenEvent {
  type: 'open';
  /** 小写标签名（未校验是否受支持）。 */
  name: string;
  selfClosing: boolean;
  raw: string;
  start: number;
  end: number;
}

export interface CloseEvent {
  type: 'close';
  name: string;
  raw: string;
  start: number;
  end: number;
}

/** 词法层事件流：只描述“源码里出现了什么”，不施加树构建规则。 */
export type ParserEvent = TextEvent | OpenEvent | CloseEvent;

export type DiagnosticCode =
  | 'malformed-tag'
  | 'unknown-tag'
  | 'unmatched-close'
  | 'implicit-close'
  | 'unclosed-tag'
  | 'unknown-entity';

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  start: number;
  end: number;
}

export interface TextNode {
  type: 'text';
  text: string;
  segments: Segment[];
  start: number;
  end: number;
}

export interface ElementNode {
  type: 'element';
  name: string;
  children: Node[];
  start: number;
  end: number;
}

export interface RootNode {
  type: 'root';
  children: Node[];
  start: number;
  end: number;
}

export type Node = ElementNode | TextNode;

export interface ParseResult {
  root: RootNode;
  diagnostics: Diagnostic[];
  events: ParserEvent[];
}
