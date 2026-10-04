/**
 * POSIX shell-style argument quoting: builds a display string from structured
 * argv and decodes it back, without ever spawning a shell.
 *
 * Encoding rules:
 *  - A NUL byte (U+0000) is rejected: it can never round-trip through argv.
 *  - A non-empty argument consisting only of safe characters is emitted as-is.
 *    `@` is deliberately NOT safe: a token starting with `@` is an include
 *    directive in response files, so it must always be quoted.
 *  - Everything else (empty string, blanks, quotes, backslashes, newlines...)
 *    is wrapped in single quotes, with embedded single quotes emitted as
 *    the classic '\'' sequence.
 *
 * Because every unsafe argument is fully wrapped in single quotes, joining
 * encoded arguments with a single space can never change the argument count.
 */
const SAFE_CHAR = /^[A-Za-z0-9_\-./:=+,]+$/;
export function assertNoNul(value, what) {
    if (value.includes("\0")) {
        throw new Error(`${what} must not contain a NUL byte`);
    }
}
/** Encode a single argument as exactly one shell word. */
export function encodeArg(arg) {
    assertNoNul(arg, "argument");
    if (arg.length > 0 && SAFE_CHAR.test(arg)) {
        return arg;
    }
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}
/** Encode a whole argv vector into a display string. */
export function encode(argv) {
    return argv.map(encodeArg).join(" ");
}
function isBlank(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
/**
 * Decode a display string into arguments, tracking the exact span each
 * argument occupies. Supports single quotes, double quotes (with backslash
 * escapes for \" \\ \$ \`) and backslash escaping outside quotes. Throws on
 * unterminated quotes, a trailing backslash, or NUL bytes.
 */
export function decodeSpans(cmdline) {
    assertNoNul(cmdline, "command line");
    const args = [];
    const n = cmdline.length;
    let i = 0;
    for (;;) {
        while (i < n && isBlank(cmdline[i]))
            i++;
        if (i >= n)
            break;
        const start = i;
        let value = "";
        while (i < n && !isBlank(cmdline[i])) {
            const ch = cmdline[i];
            if (ch === "'") {
                i++;
                const close = cmdline.indexOf("'", i);
                if (close < 0) {
                    throw new Error(`unterminated single quote at offset ${start}`);
                }
                value += cmdline.slice(i, close);
                i = close + 1;
            }
            else if (ch === '"') {
                i++;
                let closed = false;
                while (i < n) {
                    const c = cmdline[i];
                    if (c === '"') {
                        closed = true;
                        i++;
                        break;
                    }
                    if (c === "\\" && i + 1 < n && '"\\$`'.includes(cmdline[i + 1])) {
                        value += cmdline[i + 1];
                        i += 2;
                    }
                    else {
                        value += c;
                        i++;
                    }
                }
                if (!closed) {
                    throw new Error(`unterminated double quote at offset ${start}`);
                }
            }
            else if (ch === "\\") {
                if (i + 1 >= n) {
                    throw new Error(`trailing backslash at offset ${i}`);
                }
                value += cmdline[i + 1];
                i += 2;
            }
            else {
                value += ch;
                i++;
            }
        }
        args.push({ value, start, end: i });
    }
    return args;
}
/** Decode a display string into an argv vector. */
export function decode(cmdline) {
    return decodeSpans(cmdline).map((a) => a.value);
}
