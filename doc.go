// Package q207 implements a gateway middleware that normalizes URL query
// strings before they reach backends mixing first-value and last-value
// parsers.
//
// The caller configures the allowed keys, whether each key may repeat,
// and whether values must be valid UTF-8. Parsing splits on raw '&' and
// the first '=', decodes percent escapes exactly once, and treats '+' as
// a space. The whole request is rejected when decoding reveals key
// collisions, invalid escapes, control characters, or repeated
// non-repeatable keys. Accepted queries are rebuilt sorted by key
// (stable within a key) with every non-unreserved byte percent-encoded,
// so re-parsing the canonical form can never produce new keys.
//
// Rules are hot-reloadable via RuleStore; each request pins one rule
// version. The Result keeps separate SHA-256 digests of the original raw
// bytes (for signature verification) and the canonical bytes the backend
// receives.
package q207
