import { evaluate } from './evaluate.js';
import { parse } from './parser.js';
export { evaluate } from './evaluate.js';
/** 解析并求值，一步完成。 */
export function run(source, ctx) {
    return evaluate(parse(source), ctx);
}
