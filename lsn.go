package dataeng

import (
	"bytes"
	"database/sql/driver"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// LSNLen is the size of a SQL Server log sequence number. SQL Server stores
// LSNs as binary(10).
const LSNLen = 10

var (
	// ErrInvalidLSN is returned when a value cannot be interpreted as an LSN.
	ErrInvalidLSN = errors.New("sqlserver cdc: invalid LSN")
	// ErrLSNOverflow is returned when incrementing the largest possible LSN.
	ErrLSNOverflow = errors.New("sqlserver cdc: LSN overflow")
	// ErrLSNUnderflow is returned when decrementing the zero LSN.
	ErrLSNUnderflow = errors.New("sqlserver cdc: LSN underflow")
)

// LSN is a SQL Server log sequence number. Values read from SQL Server are
// binary(10); shorter values are treated as zero-padded when ordered or
// advanced.
type LSN []byte

// ParseLSN parses the two forms SQL Server commonly displays:
//
//	0000002a:0000005c:0003
//	0x0000002A0000005C0003
//
// A bare 20-character hexadecimal value is also accepted.
func ParseLSN(s string) (LSN, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("%w: empty value", ErrInvalidLSN)
	}
	parts := strings.Split(s, ":")
	switch len(parts) {
	case 1:
		s = strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	case 3:
		if len(parts[0]) != 8 || len(parts[1]) != 8 || len(parts[2]) != 4 {
			return nil, fmt.Errorf("%w: %q", ErrInvalidLSN, s)
		}
		s = parts[0] + parts[1] + parts[2]
	default:
		return nil, fmt.Errorf("%w: %q", ErrInvalidLSN, s)
	}
	if len(s) != 2*LSNLen {
		return nil, fmt.Errorf("%w: want %d hex characters, got %d", ErrInvalidLSN, 2*LSNLen, len(s))
	}
	raw, err := hex.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidLSN, err)
	}
	return LSN(raw), nil
}

// MustParseLSN is ParseLSN for static values. It panics on invalid input.
func MustParseLSN(s string) LSN {
	lsn, err := ParseLSN(s)
	if err != nil {
		panic(err)
	}
	return lsn
}

// LSNFromBytes constructs an LSN from a binary(10) value.
func LSNFromBytes(raw []byte) (LSN, error) {
	if len(raw) != LSNLen {
		return nil, fmt.Errorf("%w: want %d bytes, got %d", ErrInvalidLSN, LSNLen, len(raw))
	}
	return LSN(append([]byte(nil), raw...)), nil
}

// NewLSN is an alias for LSNFromBytes.
func NewLSN(raw []byte) (LSN, error) {
	return LSNFromBytes(raw)
}

// Bytes returns a copy of the raw LSN.
func (l LSN) Bytes() []byte {
	if l == nil {
		return nil
	}
	return append([]byte(nil), l...)
}

// IsZero reports whether the LSN is empty or consists only of zero bytes.
func (l LSN) IsZero() bool {
	for _, b := range l {
		if b != 0 {
			return false
		}
	}
	return true
}

// String returns the canonical SQL Server display form
// xxxxxxxx:xxxxxxxx:xxxx.
func (l LSN) String() string {
	if len(l) != LSNLen {
		return "0x" + hex.EncodeToString(l)
	}
	return fmt.Sprintf("%02x%02x%02x%02x:%02x%02x%02x%02x:%02x%02x",
		l[0], l[1], l[2], l[3], l[4], l[5], l[6], l[7], l[8], l[9])
}

// Hex returns the LSN as a single hexadecimal value with a 0x prefix.
func (l LSN) Hex() string {
	return "0x" + hex.EncodeToString(l)
}

// Equal reports whether two LSNs contain the same bytes.
func (l LSN) Equal(other LSN) bool {
	return bytes.Equal(l, other)
}

// Compare orders LSNs as unsigned big-endian integers. Shorter values are
// treated as if left-padded with zero bytes.
func (l LSN) Compare(other LSN) int {
	return CompareLSN(l, other)
}

// MarshalText implements encoding.TextMarshaler.
func (l LSN) MarshalText() ([]byte, error) {
	return []byte(l.String()), nil
}

// UnmarshalText implements encoding.TextUnmarshaler.
func (l *LSN) UnmarshalText(text []byte) error {
	parsed, err := ParseLSN(string(text))
	if err != nil {
		return err
	}
	*l = parsed
	return nil
}

// MarshalJSON encodes an LSN using its canonical colon-separated form.
func (l LSN) MarshalJSON() ([]byte, error) {
	return json.Marshal(l.String())
}

// UnmarshalJSON decodes either a string LSN or a base64-encoded byte slice
// (the default encoding/json representation of []byte).
func (l *LSN) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		if parsed, err := ParseLSN(text); err == nil {
			*l = parsed
			return nil
		}
		raw, err := base64.StdEncoding.DecodeString(text)
		if err != nil {
			return fmt.Errorf("%w: %q", ErrInvalidLSN, text)
		}
		*l = LSN(raw)
		return nil
	}
	var raw []byte
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidLSN, err)
	}
	*l = LSN(raw)
	return nil
}

// Scan implements sql.Scanner.
func (l *LSN) Scan(src any) error {
	switch value := src.(type) {
	case nil:
		*l = nil
		return nil
	case []byte:
		*l = append((*l)[:0], value...)
		return nil
	case string:
		parsed, err := ParseLSN(value)
		if err != nil {
			return err
		}
		*l = parsed
		return nil
	default:
		return fmt.Errorf("%w: cannot scan %T", ErrInvalidLSN, src)
	}
}

// Value implements driver.Valuer.
func (l LSN) Value() (driver.Value, error) {
	return l.Bytes(), nil
}

// CompareLSN orders two LSNs as unsigned big-endian integers. A nil or empty
// LSN compares equal to the all-zero LSN.
func CompareLSN(a, b LSN) int {
	width := len(a)
	if len(b) > width {
		width = len(b)
	}
	for i := 0; i < width; i++ {
		var left, right byte
		if offset := len(a) - width + i; offset >= 0 {
			left = a[offset]
		}
		if offset := len(b) - width + i; offset >= 0 {
			right = b[offset]
		}
		switch {
		case left < right:
			return -1
		case left > right:
			return 1
		}
	}
	return 0
}

// IncrementLSN returns the smallest LSN greater than l, matching
// sys.fn_cdc_increment_lsn. The result is always binary(10).
func IncrementLSN(l LSN) (LSN, error) {
	out, ok := normalizedLSN(l)
	if !ok {
		return nil, fmt.Errorf("%w: length %d exceeds %d", ErrInvalidLSN, len(l), LSNLen)
	}
	for i := LSNLen - 1; i >= 0; i-- {
		out[i]++
		if out[i] != 0 {
			return LSN(out), nil
		}
	}
	return nil, ErrLSNOverflow
}

// MustIncrementLSN is IncrementLSN for values that cannot overflow.
func MustIncrementLSN(l LSN) LSN {
	out, err := IncrementLSN(l)
	if err != nil {
		panic(err)
	}
	return out
}

// DecrementLSN returns the largest LSN smaller than l, matching
// sys.fn_cdc_decrement_lsn. The result is always binary(10).
func DecrementLSN(l LSN) (LSN, error) {
	out, ok := normalizedLSN(l)
	if !ok {
		return nil, fmt.Errorf("%w: length %d exceeds %d", ErrInvalidLSN, len(l), LSNLen)
	}
	for i := LSNLen - 1; i >= 0; i-- {
		out[i]--
		if out[i] != 0xff {
			return LSN(out), nil
		}
	}
	return nil, ErrLSNUnderflow
}

func normalizedLSN(l LSN) ([]byte, bool) {
	if len(l) > LSNLen {
		return nil, false
	}
	out := make([]byte, LSNLen)
	copy(out[LSNLen-len(l):], l)
	return out, true
}
