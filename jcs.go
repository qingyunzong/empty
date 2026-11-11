package q216

// RFC 8785 (JSON Canonicalization Scheme, JCS) canonicalization plus a
// strict JSON decoder that rejects duplicate object keys.
//
// Only the JSON subset produced by encoding/json is needed: objects,
// arrays, strings, booleans, null and numbers. Numbers entering the
// canonicalizer through the strict decoder are retained as json.Number so
// their original lexical form is preserved for the ECMAScript-style
// numeric serialization required by JCS.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

// decodeJSONStrict decodes data into a generic JSON tree, rejecting
// duplicate object keys and any trailing data.
func decodeJSONStrict(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	val, err := decodeJSONValue(dec)
	if err != nil {
		return nil, err
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("q216: unexpected trailing JSON data")
		}
		return nil, fmt.Errorf("q216: invalid JSON: %w", err)
	}
	return val, nil
}

func decodeJSONValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("q216: invalid JSON: %w", err)
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := make(map[string]any)
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, fmt.Errorf("q216: invalid JSON object key: %w", err)
				}
				key, ok := keyTok.(string)
				if !ok {
					return nil, fmt.Errorf("q216: invalid JSON object key")
				}
				if _, exists := obj[key]; exists {
					return nil, fmt.Errorf("q216: duplicate JSON object key %q", key)
				}
				child, err := decodeJSONValue(dec)
				if err != nil {
					return nil, err
				}
				obj[key] = child
			}
			// Consume the closing '}'.
			if _, err := dec.Token(); err != nil {
				return nil, fmt.Errorf("q216: unterminated JSON object: %w", err)
			}
			return obj, nil
		case '[':
			arr := make([]any, 0)
			for dec.More() {
				child, err := decodeJSONValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, child)
			}
			if _, err := dec.Token(); err != nil {
				return nil, fmt.Errorf("q216: unterminated JSON array: %w", err)
			}
			return arr, nil
		default:
			return nil, fmt.Errorf("q216: unexpected JSON delimiter %q", t)
		}
	case json.Number, string, bool, nil:
		return t, nil
	default:
		return nil, fmt.Errorf("q216: unsupported JSON token %T", tok)
	}
}

// canonicalJSON returns the RFC 8785 canonical JSON bytes of a generic JSON
// tree (as produced by decodeJSONStrict), or of plain Go scalar types.
func canonicalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeCanonical(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sortUTF16(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeJSONString(buf, k)
			buf.WriteByte(':')
			if err := writeCanonical(buf, t[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, child := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, child); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case string:
		writeJSONString(buf, t)
	case json.Number:
		s, err := canonicalNumber(t)
		if err != nil {
			return err
		}
		buf.WriteString(s)
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case nil:
		buf.WriteString("null")
	case int:
		buf.WriteString(strconv.FormatInt(int64(t), 10))
	case int64:
		buf.WriteString(strconv.FormatInt(t, 10))
	case float64:
		s, err := canonicalNumber(json.Number(strconv.FormatFloat(t, 'g', -1, 64)))
		if err != nil {
			return err
		}
		buf.WriteString(s)
	default:
		return fmt.Errorf("q216: cannot canonicalize value of type %T", v)
	}
	return nil
}

// writeJSONString emits a minimal JSON string: only quotation marks,
// reverse soliduses and control characters U+0000..U+001F are escaped,
// matching RFC 8785 section 3.2.2.2.
func writeJSONString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for i := 0; i < len(s); {
		b := s[i]
		switch {
		case b == '"' || b == '\\':
			buf.WriteByte('\\')
			buf.WriteByte(b)
			i++
		case b < 0x20:
			const hex = "0123456789abcdef"
			buf.WriteString(`\u00`)
			buf.WriteByte(hex[b>>4])
			buf.WriteByte(hex[b&0x0f])
			i++
		default:
			// Copy the whole rune (valid UTF-8 is emitted verbatim).
			_, size := decodeRune(s[i:])
			if size <= 0 {
				size = 1
			}
			buf.WriteString(s[i : i+size])
			i += size
		}
	}
	buf.WriteByte('"')
}

// sortUTF16 sorts strings lexicographically by their UTF-16 code unit
// sequences, as mandated by RFC 8785 section 3.2.3.
func sortUTF16(keys []string) {
	// Insertion sort is fine: object key counts are small.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && utf16Less(keys[j], keys[j-1]); j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
}

func utf16Less(a, b string) bool {
	au := utf16Units(a)
	bu := utf16Units(b)
	n := len(au)
	if len(bu) < n {
		n = len(bu)
	}
	for i := 0; i < n; i++ {
		if au[i] != bu[i] {
			return au[i] < bu[i]
		}
	}
	return len(au) < len(bu)
}

func utf16Units(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for _, r := range s {
		if r <= 0xFFFF {
			out = append(out, uint16(r))
			continue
		}
		r -= 0x10000
		out = append(out, 0xD800+uint16(r>>10), 0xDC00+uint16(r&0x3FF))
	}
	return out
}

// canonicalNumber implements the ECMAScript Number::toString decimal
// serialization defined in RFC 8785 section 3.2.2.3.
func canonicalNumber(n json.Number) (string, error) {
	s := n.String()
	// Integer literals are always emitted in plain decimal notation. This
	// covers values larger than int64 (such as 1e20) without losing
	// lexical fidelity.
	if plain, ok := exactDecimalInteger(s); ok {
		return plain, nil
	}
	f, err := n.Float64()
	if err != nil {
		// Values beyond int64 that are still exact decimal integers (for
		// example the 21-digit value 1e20) must stay in plain notation
		// rather than being forced through float64's scientific path.
		if plain, ok := exactDecimalInteger(s); ok {
			return plain, nil
		}
		return "", fmt.Errorf("q216: number %s is not representable as an IEEE-754 double", s)
	}
	if f == 0 {
		return "0", nil // collapses -0 to 0 per ECMAScript
	}
	return formatESNumber(f), nil
}

// exactDecimalInteger reports whether s is a JSON integer literal and
// returns its canonical plain decimal form. JSON disallows leading zeros,
// so a successful parse is already canonical.
func exactDecimalInteger(s string) (string, bool) {
	digits := s
	if strings.HasPrefix(digits, "-") {
		digits = digits[1:]
	}
	if digits == "" {
		return "", false
	}
	for _, r := range digits {
		if r < '0' || r > '9' {
			return "", false
		}
	}
	// ECMAScript treats -0 and 0 identically.
	if s == "-0" {
		return "0", true
	}
	return s, true
}

// formatESNumber formats a non-zero float64 exactly like ECMAScript's
// Number.prototype.toString (shortest round-tripping decimal, plain
// notation for -6 <= exponent <= 20, scientific notation otherwise, with a
// two-character signed exponent).
func formatESNumber(f float64) string {
	negative := f < 0
	if negative {
		f = -f
	}
	// 'e' with -1 precision gives the shortest digit string (k digits) and
	// a base-10 exponent equal to n - 1, where n is the exponent defined
	// by the ECMAScript Number::toString algorithm.
	sci := strconv.FormatFloat(f, 'e', -1, 64)
	ePos := strings.IndexByte(sci, 'e')
	digits := strings.ReplaceAll(sci[:ePos], ".", "")
	k := len(digits)
	expPrinted, err := strconv.Atoi(sci[ePos+1:])
	if err != nil {
		// Unreachable for float64 formatting output.
		return sci
	}
	// Go's scientific exponent is already n - 1.
	n := expPrinted + 1

	var mantissa string
	switch {
	case n <= 0:
		mantissa = "0." + strings.Repeat("0", -n) + digits
	case n > 0 && n < k:
		mantissa = digits[:n] + "." + digits[n:]
	default: // n >= k
		mantissa = digits + strings.Repeat("0", n-k)
	}

	var out string
	if n <= -6 || n >= 21 {
		exponent := n - 1
		sign := "+"
		if exponent < 0 {
			sign = "-"
			exponent = -exponent
		}
		head := string(digits[0])
		if k > 1 {
			head += "." + digits[1:]
		}
		out = head + "e" + sign + strconv.Itoa(exponent)
	} else {
		out = mantissa
	}
	if negative {
		return "-" + out
	}
	return out
}

// decodeRune wraps utf8.DecodeRuneInString locally so the file keeps a
// single import block style.
func decodeRune(s string) (rune, int) {
	return utf8.DecodeRuneInString(s)
}

// strictUnmarshal canonicalizes the already-validated generic tree and
// unmarshals it into dst using DisallowUnknownFields, so structural
// validation and unknown-field rejection share one trusted representation.
func strictUnmarshal(tree any, dst any) error {
	canon, err := canonicalJSON(tree)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(canon))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("q216: schema validation failed: %w", err)
	}
	if dec.More() {
		return fmt.Errorf("q216: unexpected trailing JSON data")
	}
	return nil
}

// requirePositiveInt extracts a strictly positive integer field from the
// generic JSON tree, rejecting fractional, non-numeric or zero values.
func requirePositiveInt(tree map[string]any, field string) (int64, error) {
	raw, ok := tree[field]
	if !ok {
		return 0, fmt.Errorf("q216: missing required field %q", field)
	}
	num, ok := raw.(json.Number)
	if !ok {
		return 0, fmt.Errorf("q216: field %q must be an integer", field)
	}
	v, err := num.Int64()
	if err != nil {
		return 0, fmt.Errorf("q216: field %q must be an integer", field)
	}
	if v <= 0 {
		return 0, fmt.Errorf("q216: field %q must be positive", field)
	}
	return v, nil
}

// requireString extracts a non-empty string field from the generic JSON tree.
func requireString(tree map[string]any, field string) (string, error) {
	raw, ok := tree[field]
	if !ok {
		return "", fmt.Errorf("q216: missing required field %q", field)
	}
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("q216: field %q must be a non-empty string", field)
	}
	return s, nil
}
