package formal

import "strconv"

// LSN is a byte offset in the commit log. Record end LSNs are exclusive:
// a record is durable exactly when DurableLSN >= the record's EndLSN.
type LSN uint64

// String renders an LSN as an unsigned decimal byte offset.
func (l LSN) String() string {
	return strconv.FormatUint(uint64(l), 10)
}

// IsZero reports whether the LSN is the start of the log.
func (l LSN) IsZero() bool {
	return l == 0
}
