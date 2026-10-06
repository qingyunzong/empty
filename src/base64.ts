const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const REVERSE = new Map<string, number>(
  [...ALPHABET].map((ch, i) => [ch, i] as [string, number]),
);

export function encodeBase64(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i] as number;
    const b1 = i + 1 < data.length ? (data[i + 1] as number) : 0;
    const b2 = i + 2 < data.length ? (data[i + 2] as number) : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < data.length ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < data.length ? ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

/** Strict decoder: throws on any character outside the alphabet or bad padding. */
export function decodeBase64(text: string): Uint8Array {
  if (typeof text !== "string" || text.length % 4 !== 0) {
    throw new Error("invalid base64 length");
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    const pad = chunk.indexOf("=");
    if (pad !== -1 && (pad < 2 || i + 4 !== text.length || !/^=+$/.test(chunk.slice(pad)))) {
      throw new Error("invalid base64 padding");
    }
    const vals: number[] = [];
    for (const ch of chunk) {
      if (ch === "=") {
        vals.push(0);
        continue;
      }
      const v = REVERSE.get(ch);
      if (v === undefined) {
        throw new Error(`invalid base64 character ${JSON.stringify(ch)}`);
      }
      vals.push(v);
    }
    const n = ((vals[0] as number) << 18) | ((vals[1] as number) << 12) |
      ((vals[2] as number) << 6) | (vals[3] as number);
    bytes.push((n >> 16) & 0xff);
    if (pad === -1 || pad < 3) bytes.push((n >> 8) & 0xff);
    if (pad === -1 || pad < 2) bytes.push(n & 0xff);
  }
  return new Uint8Array(bytes);
}
