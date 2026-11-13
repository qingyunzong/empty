package dataeng

import (
	"fmt"
	"strconv"
	"strings"
)

// LSN is a Postgres log sequence number (byte offset in the WAL).
type LSN uint64

// ParseLSN parses the textual "X/XXXXXXXX" form, e.g. "0/16B6C50".
func ParseLSN(s string) (LSN, error) {
	parts := strings.Split(s, "/")
	if len(parts) != 2 {
		return 0, fmt.Errorf("dataeng: invalid LSN %q", s)
	}
	hi, err := strconv.ParseUint(parts[0], 16, 32)
	if err != nil {
		return 0, fmt.Errorf("dataeng: invalid LSN %q: %w", s, err)
	}
	lo, err := strconv.ParseUint(parts[1], 16, 32)
	if err != nil {
		return 0, fmt.Errorf("dataeng: invalid LSN %q: %w", s, err)
	}
	return LSN(hi<<32 | lo), nil
}

func (l LSN) String() string {
	return fmt.Sprintf("%X/%X", uint32(uint64(l)>>32), uint32(uint64(l)))
}
