package dataeng

import (
	"errors"
	"strings"
)

// ErrInvalidETag is returned when a header value cannot be parsed as an
// entity-tag (RFC 9110, section 8.8.3).
var ErrInvalidETag = errors.New("dataeng: invalid ETag")

// ETag is a parsed entity-tag. Wildcard represents the special "*" value,
// which is not an entity-tag and may only match when a representation body
// is already held locally.
type ETag struct {
	Weak     bool
	Opaque   string
	Wildcard bool
}

// ParseETag parses a single entity-tag such as `"v1"`, `W/"v1"` or `*`.
func ParseETag(value string) (*ETag, error) {
	tag := strings.TrimSpace(value)
	if tag == "*" {
		return &ETag{Wildcard: true}, nil
	}

	weak := false
	if strings.HasPrefix(tag, "W/") {
		weak = true
		tag = tag[2:]
	}

	if len(tag) < 2 || tag[0] != '"' {
		return nil, ErrInvalidETag
	}

	for i := 1; i < len(tag); i++ {
		switch tag[i] {
		case '"':
			if strings.TrimSpace(tag[i+1:]) != "" {
				return nil, ErrInvalidETag
			}
			return &ETag{Weak: weak, Opaque: tag[1:i]}, nil
		case '\\':
			i++
			if i >= len(tag) {
				return nil, ErrInvalidETag
			}
		}
	}

	return nil, ErrInvalidETag
}

// ParseETags parses a comma-separated entity-tag list such as the value of
// an If-None-Match header. Quoted strings are kept intact while splitting.
func ParseETags(value string) ([]*ETag, error) {
	var tags []*ETag
	for _, part := range splitTagList(value) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		tag, err := ParseETag(part)
		if err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, nil
}

func splitTagList(value string) []string {
	var parts []string
	var start int
	inQuote := false
	escaped := false

	for i := 0; i < len(value); i++ {
		c := value[i]
		if inQuote {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inQuote = false
			}
			continue
		}

		switch c {
		case '"':
			inQuote = true
		case ',':
			parts = append(parts, value[start:i])
			start = i + 1
		}
	}

	return append(parts, value[start:])
}

// StrongEqual reports whether both tags are strong and share the same opaque
// value. Wildcards never compare equal here; they are handled separately.
func (e *ETag) StrongEqual(other *ETag) bool {
	if e == nil || other == nil {
		return false
	}
	if e.Wildcard || other.Wildcard {
		return false
	}
	return !e.Weak && !other.Weak && e.Opaque == other.Opaque
}

// WeakEqual reports whether the tags share the same opaque value, regardless
// of either tag's weakness indicator. A strong tag therefore satisfies a
// weak comparison, while a weak tag never satisfies a strong one.
func (e *ETag) WeakEqual(other *ETag) bool {
	if e == nil || other == nil {
		return false
	}
	if e.Wildcard || other.Wildcard {
		return false
	}
	return e.Opaque == other.Opaque
}

// String renders the tag back into its wire form.
func (e *ETag) String() string {
	if e == nil {
		return ""
	}
	if e.Wildcard {
		return "*"
	}
	if e.Weak {
		return `W/"` + e.Opaque + `"`
	}
	return `"` + e.Opaque + `"`
}
