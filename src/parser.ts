import { Tokenizer } from './tokenizer.js';
import { TreeBuilder } from './tree.js';
import type { Diagnostic, ParseResult, ParserEvent } from './types.js';

/**
 * 增量预览解析器：write() 喂入任意切分的字符串块，end() 结束并返回结果。
 * 同一输入无论怎么分块，事件流、树与诊断顺序完全一致。
 */
export class Parser {
  readonly diagnostics: Diagnostic[] = [];
  readonly events: ParserEvent[] = [];
  private readonly tokenizer: Tokenizer;
  private readonly builder: TreeBuilder;
  private ended = false;

  constructor() {
    const report = (diagnostic: Diagnostic): void => {
      this.diagnostics.push(diagnostic);
    };
    this.builder = new TreeBuilder(report);
    this.tokenizer = new Tokenizer((event) => {
      this.events.push(event);
      this.builder.handleEvent(event);
    }, report);
  }

  write(chunk: string): this {
    if (this.ended) throw new Error('write() called after end()');
    this.tokenizer.write(chunk);
    return this;
  }

  end(): ParseResult {
    if (this.ended) throw new Error('end() called twice');
    this.ended = true;
    this.tokenizer.end();
    const root = this.builder.finish(this.tokenizer.position);
    return { root, diagnostics: this.diagnostics, events: this.events };
  }
}

/** 一次性解析完整输入。 */
export function parse(input: string): ParseResult {
  const parser = new Parser();
  parser.write(input);
  return parser.end();
}
