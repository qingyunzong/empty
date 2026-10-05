export {
  encode,
  encodePairs,
  utf8KeyBytes,
  hasLoneSurrogate,
  compareBytes,
  EncodeError,
  TAG_UINT,
  TAG_NEGINT,
  TAG_BYTES,
  TAG_ARRAY,
  TAG_OBJECT,
  TAG_KEY,
} from "./encode.js";
export type { CanonicalValue } from "./encode.js";
export { StreamParser, ParseError, utf8ErrorIndex } from "./parse.js";
export type { ParsedValue } from "./parse.js";
export { digest, digestHex } from "./digest.js";
