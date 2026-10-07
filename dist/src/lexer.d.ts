export type TokenType = 'num' | 'str' | 'ident' | 'bool' | 'null' | 'op' | 'lparen' | 'rparen' | 'eof';
export interface Token {
    type: TokenType;
    /** num 为数字文本，str 为解码后内容，ident 为字段名，op 为运算符，bool 为 'true'|'false' */
    value: string;
    /** token 起始位置在源串中的 UTF-8 字节偏移 */
    bytePos: number;
}
export declare function tokenize(source: string): Token[];
