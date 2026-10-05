import { ParseError } from "./errors.js";
const isDigit = (ch) => ch >= "0" && ch <= "9";
const isUnit = (ch) => ch === "万" || ch === "亿";
export function lex(text) {
    const tokens = [];
    let i = 0;
    let byte = 0;
    while (i < text.length) {
        const ch = text[i];
        const start = i;
        const byteStart = byte;
        if (isDigit(ch)) {
            let j = i;
            while (j < text.length && isDigit(text[j]))
                j++;
            const raw = text.slice(i, j);
            tokens.push({
                kind: "digits",
                raw,
                start,
                end: j,
                byteStart,
                byteEnd: byteStart + raw.length,
                index: tokens.length,
            });
            byte += raw.length;
            i = j;
        }
        else if (isUnit(ch)) {
            tokens.push({
                kind: "unit",
                raw: ch,
                start,
                end: start + 1,
                byteStart,
                byteEnd: byteStart + 3,
                index: tokens.length,
            });
            byte += 3;
            i += 1;
        }
        else if (ch === ".") {
            tokens.push({
                kind: "dot",
                raw: ".",
                start,
                end: start + 1,
                byteStart,
                byteEnd: byteStart + 1,
                index: tokens.length,
            });
            byte += 1;
            i += 1;
        }
        else {
            throw new ParseError("INVALID_CHAR", `非法字符「${ch}」`, start);
        }
    }
    return tokens;
}
