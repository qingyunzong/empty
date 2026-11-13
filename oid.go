package dataeng

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ErrEmptyOID is returned when an empty object identifier is supplied.
var ErrEmptyOID = errors.New("dataeng: empty OID")

// OID is an SNMP object identifier. Sub-identifiers are unsigned 32-bit
// values, as required by the SNMP protocol.
type OID []uint32

// ParseOID parses a dotted-decimal object identifier. A single leading dot is
// accepted, so both "1.3.6.1" and ".1.3.6.1" are valid.
func ParseOID(s string) (OID, error) {
	text := strings.TrimSpace(s)
	text = strings.TrimPrefix(text, ".")
	if text == "" {
		return nil, ErrEmptyOID
	}

	parts := strings.Split(text, ".")
	oid := make(OID, len(parts))
	for i, part := range parts {
		if part == "" {
			return nil, fmt.Errorf("dataeng: invalid OID %q: empty sub-identifier", s)
		}
		value, err := strconv.ParseUint(part, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("dataeng: invalid OID %q: %w", s, err)
		}
		oid[i] = uint32(value)
	}
	return oid, nil
}

// MustParseOID is like ParseOID but panics on invalid input.
func MustParseOID(s string) OID {
	oid, err := ParseOID(s)
	if err != nil {
		panic(err)
	}
	return oid
}

// ParseOIDs parses a slice of dotted-decimal object identifiers.
func ParseOIDs(values []string) ([]OID, error) {
	oids := make([]OID, len(values))
	for i, value := range values {
		oid, err := ParseOID(value)
		if err != nil {
			return nil, fmt.Errorf("dataeng: OID at index %d: %w", i, err)
		}
		oids[i] = oid
	}
	return oids, nil
}

// NewOID returns an OID containing parts.
func NewOID(parts ...uint32) OID {
	if len(parts) == 0 {
		return nil
	}
	return CloneOID(parts)
}

// CloneOID returns an independent copy of oid.
func CloneOID(oid OID) OID {
	if oid == nil {
		return nil
	}
	clone := make(OID, len(oid))
	copy(clone, oid)
	return clone
}

// Clone returns an independent copy of the OID.
func (oid OID) Clone() OID {
	return CloneOID(oid)
}

// String returns the OID in dotted-decimal form without a leading dot.
func (oid OID) String() string {
	if len(oid) == 0 {
		return ""
	}
	var builder strings.Builder
	for i, part := range oid {
		if i != 0 {
			builder.WriteByte('.')
		}
		builder.WriteString(strconv.FormatUint(uint64(part), 10))
	}
	return builder.String()
}

// Dotted returns the OID with a leading dot.
func (oid OID) Dotted() string {
	if len(oid) == 0 {
		return ""
	}
	return "." + oid.String()
}

// Equal reports whether oid and other contain the same sub-identifiers.
func (oid OID) Equal(other OID) bool {
	return oid.Compare(other) == 0
}

// Compare compares oid and other lexicographically, as SNMP orders object
// identifiers. It returns -1, 0, or 1.
func (oid OID) Compare(other OID) int {
	limit := len(oid)
	if len(other) < limit {
		limit = len(other)
	}
	for i := 0; i < limit; i++ {
		switch {
		case oid[i] < other[i]:
			return -1
		case oid[i] > other[i]:
			return 1
		}
	}
	switch {
	case len(oid) < len(other):
		return -1
	case len(oid) > len(other):
		return 1
	default:
		return 0
	}
}

// HasPrefix reports whether prefix is a prefix of oid.
func (oid OID) HasPrefix(prefix OID) bool {
	if len(prefix) > len(oid) {
		return false
	}
	for i := range prefix {
		if oid[i] != prefix[i] {
			return false
		}
	}
	return true
}

// Suffix returns the sub-identifiers after prefix. The bool result is false
// when prefix is not a prefix of oid.
func (oid OID) Suffix(prefix OID) (OID, bool) {
	if !oid.HasPrefix(prefix) {
		return nil, false
	}
	return CloneOID(oid[len(prefix):]), true
}
