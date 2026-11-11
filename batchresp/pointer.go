package batchresp

import (
	"fmt"
	"strconv"
	"strings"
)

// Ref is a parsed cross-segment reference of the form
// "<Content-ID>#<RFC 6901 JSON Pointer>".
//
// An empty pointer ("id#") refers to the whole target document.
type Ref struct {
	// ID is the Content-ID of the target segment.
	ID string
	// Pointer is the raw RFC 6901 JSON Pointer text.
	Pointer string
	tokens  []string
}

// ParseRef parses a reference string and validates its JSON Pointer
// portion according to RFC 6901, including "~0"/"~1" escaping rules.
func ParseRef(s string) (Ref, error) {
	hash := strings.IndexByte(s, '#')
	if hash <= 0 {
		return Ref{}, fmt.Errorf("%w: %q", ErrInvalidRef, s)
	}
	id := s[:hash]
	pointer := s[hash+1:]
	tokens, err := parsePointer(pointer)
	if err != nil {
		return Ref{}, err
	}
	return Ref{ID: id, Pointer: pointer, tokens: tokens}, nil
}

// parsePointer splits an RFC 6901 JSON Pointer into decoded reference
// tokens. The empty pointer yields no tokens and addresses the whole
// document.
func parsePointer(p string) ([]string, error) {
	if p == "" {
		return nil, nil
	}
	if p[0] != '/' {
		return nil, fmt.Errorf("%w: pointer must start with '/': %q", ErrInvalidRef, p)
	}
	raw := strings.Split(p[1:], "/")
	tokens := make([]string, 0, len(raw))
	for _, part := range raw {
		token, err := unescapeToken(part)
		if err != nil {
			return nil, err
		}
		tokens = append(tokens, token)
	}
	return tokens, nil
}

// unescapeToken implements RFC 6901 token decoding: "~1" becomes '/',
// "~0" becomes '~'. Any other "~" occurrence is invalid.
func unescapeToken(token string) (string, error) {
	var b strings.Builder
	for i := 0; i < len(token); i++ {
		if token[i] != '~' {
			b.WriteByte(token[i])
			continue
		}
		if i+1 >= len(token) {
			return "", fmt.Errorf("%w: trailing '~' in token %q", ErrInvalidRef, token)
		}
		switch token[i+1] {
		case '0':
			b.WriteByte('~')
		case '1':
			b.WriteByte('/')
		default:
			return "", fmt.Errorf("%w: invalid escape %q in token %q",
				ErrInvalidRef, token[i:i+2], token)
		}
		i++
	}
	return b.String(), nil
}

// evalPointer evaluates decoded reference tokens against a decoded JSON
// value. Object keys are matched exactly (after unescaping); array
// indices must be decimal numbers without leading zeros.
func evalPointer(v any, tokens []string) (any, error) {
	current := v
	for _, token := range tokens {
		switch node := current.(type) {
		case map[string]any:
			child, ok := node[token]
			if !ok {
				return nil, fmt.Errorf("%w: object key %q not found", ErrInvalidRef, token)
			}
			current = child
		case []any:
			index, err := arrayIndex(token, len(node))
			if err != nil {
				return nil, err
			}
			current = node[index]
		default:
			return nil, fmt.Errorf("%w: cannot resolve token %q through scalar",
				ErrInvalidRef, token)
		}
	}
	return current, nil
}

// arrayIndex validates an RFC 6901 array index token. The "-" token and
// out-of-range indices are rejected because no concrete element exists.
func arrayIndex(token string, length int) (int, error) {
	if token == "-" {
		return 0, fmt.Errorf("%w: '-' is not a resolvable array index", ErrInvalidRef)
	}
	if len(token) > 1 && token[0] == '0' {
		return 0, fmt.Errorf("%w: leading zero in array index %q", ErrInvalidRef, token)
	}
	index, err := strconv.Atoi(token)
	if err != nil || index < 0 {
		return 0, fmt.Errorf("%w: invalid array index %q", ErrInvalidRef, token)
	}
	if index >= length {
		return 0, fmt.Errorf("%w: array index %d out of range (length %d)",
			ErrInvalidRef, index, length)
	}
	return index, nil
}
