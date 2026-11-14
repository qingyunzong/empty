package dataeng

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// LSN is a PostgreSQL log sequence number. PostgreSQL renders LSNs as two
// hexadecimal 32-bit words, for example "0/16B6C50".
type LSN uint64

// InvalidLSN is the zero LSN. PostgreSQL reserves it to mean "no position".
const InvalidLSN LSN = 0

// ParseLSN parses a PostgreSQL LSN in "high/low" hexadecimal form.
func ParseLSN(s string) (LSN, error) {
	s = strings.TrimSpace(s)
	parts := strings.Split(s, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return InvalidLSN, fmt.Errorf("dataeng: invalid LSN %q: expected high/low hexadecimal words", s)
	}
	high, err := strconv.ParseUint(parts[0], 16, 32)
	if err != nil {
		return InvalidLSN, fmt.Errorf("dataeng: invalid LSN %q: %w", s, err)
	}
	low, err := strconv.ParseUint(parts[1], 16, 32)
	if err != nil {
		return InvalidLSN, fmt.Errorf("dataeng: invalid LSN %q: %w", s, err)
	}
	return LSN(high<<32 | low), nil
}

// MustParseLSN is ParseLSN for static configuration. It panics on bad input.
func MustParseLSN(s string) LSN {
	lsn, err := ParseLSN(s)
	if err != nil {
		panic(err)
	}
	return lsn
}

// String returns the canonical PostgreSQL representation of the LSN.
func (l LSN) String() string {
	return fmt.Sprintf("%X/%X", uint64(l)>>32, uint64(l)&0xffffffff)
}

// IsValid reports whether l is a non-zero LSN.
func (l LSN) IsValid() bool { return l != InvalidLSN }

// Compare returns -1, 0, or 1 when l is less than, equal to, or greater than
// other.
func (l LSN) Compare(other LSN) int {
	switch {
	case l < other:
		return -1
	case l > other:
		return 1
	default:
		return 0
	}
}

// Add returns l+n, reporting false on uint64 overflow.
func (l LSN) Add(n uint64) (LSN, bool) {
	sum := uint64(l) + n
	if sum < uint64(l) {
		return InvalidLSN, false
	}
	return LSN(sum), true
}

// MarshalText implements encoding.TextMarshaler.
func (l LSN) MarshalText() ([]byte, error) { return []byte(l.String()), nil }

// UnmarshalText implements encoding.TextUnmarshaler.
func (l *LSN) UnmarshalText(text []byte) error {
	parsed, err := ParseLSN(string(text))
	if err != nil {
		return err
	}
	*l = parsed
	return nil
}

// MarshalJSON encodes an LSN as a JSON string in PostgreSQL form.
func (l LSN) MarshalJSON() ([]byte, error) { return json.Marshal(l.String()) }

// UnmarshalJSON accepts either a PostgreSQL LSN string or a JSON number.
func (l *LSN) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		return l.UnmarshalText([]byte(text))
	}
	var number uint64
	if err := json.Unmarshal(data, &number); err != nil {
		return fmt.Errorf("dataeng: invalid LSN JSON %s", data)
	}
	*l = LSN(number)
	return nil
}
