package q207

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

// Rejection reasons returned by Normalize.
var (
	ErrInvalidEscape = errors.New("q207: invalid percent escape")
	ErrControlChar   = errors.New("q207: control character in decoded input")
	ErrInvalidUTF8   = errors.New("q207: value is not valid UTF-8")
	ErrUnknownKey    = errors.New("q207: key not allowed")
	ErrKeyCollision  = errors.New("q207: distinct raw keys decode to the same key")
	ErrNotRepeatable = errors.New("q207: non-repeatable key appears more than once")
)

// RejectError describes why a query string was rejected.
type RejectError struct {
	Reason error
	Detail string
}

func (e *RejectError) Error() string {
	if e.Detail == "" {
		return e.Reason.Error()
	}
	return fmt.Sprintf("%s: %s", e.Reason, e.Detail)
}

func (e *RejectError) Unwrap() error { return e.Reason }

func reject(reason error, format string, args ...any) *RejectError {
	return &RejectError{Reason: reason, Detail: fmt.Sprintf(format, args...)}
}

// Pair is one decoded key/value pair.
type Pair struct {
	Key   string
	Value string

	rawKey string // raw encoding of the key, for collision detection
}

// Result is the outcome of a successful normalization.
type Result struct {
	// Version is the rule version pinned for this request.
	Version uint64
	// Pairs are the accepted pairs, sorted by key, stable within a key.
	Pairs []Pair
	// Canonical is the rebuilt query string sent to the backend.
	Canonical string
	// RawDigest is the SHA-256 of the original raw query bytes,
	// kept for signature verification.
	RawDigest [sha256.Size]byte
	// CanonicalDigest is the SHA-256 of the canonical bytes the
	// backend actually receives.
	CanonicalDigest [sha256.Size]byte
}

// RawDigestHex returns the hex-encoded digest of the original bytes.
func (r *Result) RawDigestHex() string { return hex.EncodeToString(r.RawDigest[:]) }

// CanonicalDigestHex returns the hex-encoded digest of the canonical bytes.
func (r *Result) CanonicalDigestHex() string {
	return hex.EncodeToString(r.CanonicalDigest[:])
}

// hasControl reports whether s contains bytes below 0x20 or 0x7F.
func hasControl(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] == 0x7f {
			return true
		}
	}
	return false
}

func isHex(c byte) bool {
	return ('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F')
}

func unhex(c byte) byte {
	switch {
	case '0' <= c && c <= '9':
		return c - '0'
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

// decodeOnce percent-decodes s exactly once; '+' becomes a space.
// Any '%' not followed by two hex digits is rejected.
func decodeOnce(s string) (string, error) {
	if !strings.ContainsAny(s, "%+") {
		return s, nil
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '+':
			b.WriteByte(' ')
		case '%':
			if i+2 >= len(s) || !isHex(s[i+1]) || !isHex(s[i+2]) {
				return "", reject(ErrInvalidEscape, "bad escape at offset %d in %q", i, s)
			}
			b.WriteByte(unhex(s[i+1])<<4 | unhex(s[i+2]))
			i += 2
		default:
			b.WriteByte(c)
		}
	}
	return b.String(), nil
}

// unreserved characters per RFC 3986; everything else is percent-encoded
// so that re-parsing the canonical form can never yield new keys or split
// values at encoded separators.
func isUnreserved(c byte) bool {
	switch {
	case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9':
		return true
	}
	return c == '-' || c == '.' || c == '_' || c == '~'
}

const upperHex = "0123456789ABCDEF"

// encodeCanonical encodes every non-unreserved byte as %XX (uppercase);
// spaces become %20 rather than '+' to keep the form unambiguous.
func encodeCanonical(s string) string {
	if s == "" {
		return ""
	}
	need := false
	for i := 0; i < len(s); i++ {
		if !isUnreserved(s[i]) {
			need = true
			break
		}
	}
	if !need {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) * 3)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isUnreserved(c) {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(upperHex[c>>4])
			b.WriteByte(upperHex[c&0x0f])
		}
	}
	return b.String()
}

// parseRawQuery splits on raw '&' and the first '=' of each segment, then
// decodes each side exactly once. Empty segments (from "&&" or a trailing
// '&') are skipped; a segment without '=' has an empty value.
func parseRawQuery(raw string) ([]Pair, error) {
	var pairs []Pair
	rest := raw
	for rest != "" {
		seg := rest
		if i := strings.IndexByte(rest, '&'); i >= 0 {
			seg, rest = rest[:i], rest[i+1:]
		} else {
			rest = ""
		}
		if seg == "" {
			continue
		}
		rawKey, rawVal, _ := strings.Cut(seg, "=")
		key, err := decodeOnce(rawKey)
		if err != nil {
			return nil, err
		}
		val, err := decodeOnce(rawVal)
		if err != nil {
			return nil, err
		}
		pairs = append(pairs, Pair{Key: key, Value: val, rawKey: rawKey})
	}
	return pairs, nil
}

// normalize applies the rules to decoded pairs and rebuilds the canonical
// query string.
func normalize(raw string, pairs []Pair, rules *Rules) (*Result, error) {
	rawForm := make(map[string]string, len(pairs)) // decoded key -> first raw encoding seen
	count := make(map[string]int, len(pairs))
	for _, p := range pairs {
		if hasControl(p.Key) {
			return nil, reject(ErrControlChar, "key %q", p.Key)
		}
		if hasControl(p.Value) {
			return nil, reject(ErrControlChar, "value of key %q", p.Key)
		}
		rule, ok := rules.Keys[p.Key]
		if !ok {
			return nil, reject(ErrUnknownKey, "key %q", p.Key)
		}
		if rules.RequireUTF8Values && !utf8.ValidString(p.Value) {
			return nil, reject(ErrInvalidUTF8, "value of key %q", p.Key)
		}
		// Collision check: two different raw encodings of the same decoded
		// key are a smuggling vector even when the key is repeatable.
		if first, seen := rawForm[p.Key]; seen && first != p.rawKey {
			return nil, reject(ErrKeyCollision, "key %q encoded as %q and %q", p.Key, first, p.rawKey)
		}
		rawForm[p.Key] = p.rawKey
		count[p.Key]++
		if count[p.Key] > 1 && !rule.Repeatable {
			return nil, reject(ErrNotRepeatable, "key %q", p.Key)
		}
	}

	sorted := make([]Pair, len(pairs))
	copy(sorted, pairs)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Key < sorted[j].Key })

	var b strings.Builder
	for i, p := range sorted {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(encodeCanonical(p.Key))
		b.WriteByte('=')
		b.WriteString(encodeCanonical(p.Value))
	}
	canonical := b.String()

	return &Result{
		Pairs:           sorted,
		Canonical:       canonical,
		RawDigest:       sha256.Sum256([]byte(raw)),
		CanonicalDigest: sha256.Sum256([]byte(canonical)),
	}, nil
}

// Normalize parses raw (a raw query string without the leading '?') under
// the given rules. On success it returns the canonical form and digests;
// on any rule violation it rejects the whole request with a *RejectError.
func Normalize(raw string, rules *Rules) (*Result, error) {
	if err := rules.validate(); err != nil {
		return nil, err
	}
	pairs, err := parseRawQuery(raw)
	if err != nil {
		return nil, err
	}
	return normalize(raw, pairs, rules)
}
