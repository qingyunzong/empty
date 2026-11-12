package dataeng

import (
	"fmt"
	"math"
)

const (
	// MinPageSize and MaxPageSize are the accepted page lengths.
	MinPageSize = 512
	MaxPageSize = 65536
	// MinUsablePageSize is the minimum U = S - R.
	MinUsablePageSize = 480
)

// Config describes the immutable snapshot and resource limits. PageCount is
// the total number of S-byte pages in the snapshot. Budget fields are strict
// ceilings; zero means that no bytes or pages are allowed for that category.
type Config struct {
	PageSize             int
	ReservedBytes        int
	PageCount            uint64
	HeaderByteBudget     uint64
	ChainPageBudget      uint64
	ProjectionByteBudget uint64
}

// CellRef locates the exact target cell. Offset is a zero-based offset inside
// the page. Length is the complete cell size, including varints and, when
// present, the 4-byte first overflow pointer.
type CellRef struct {
	Page   uint64
	Offset int
	Length int
}

// Validate checks the snapshot geometry without reading the ReaderAt.
func (c Config) Validate() error {
	if c.PageSize < MinPageSize || c.PageSize > MaxPageSize ||
		c.PageSize&(c.PageSize-1) != 0 {
		return &Error{Cause: ErrInvalidConfig, Detail: fmt.Sprintf("page size %d is not a power of two in [%d,%d]", c.PageSize, MinPageSize, MaxPageSize)}
	}
	if c.ReservedBytes < 0 || c.ReservedBytes >= c.PageSize {
		return &Error{Cause: ErrInvalidConfig, Detail: fmt.Sprintf("reserved bytes %d is outside [0,%d)", c.ReservedBytes, c.PageSize)}
	}
	if usable := c.PageSize - c.ReservedBytes; usable < MinUsablePageSize {
		return &Error{Cause: ErrInvalidConfig, Detail: fmt.Sprintf("usable page size %d is below %d", usable, MinUsablePageSize)}
	}
	if c.PageCount == 0 {
		return &Error{Cause: ErrInvalidConfig, Detail: "page count is zero"}
	}
	if c.PageCount > uint64(math.MaxInt64)/uint64(c.PageSize) {
		return &Error{Cause: ErrInvalidConfig, Detail: "snapshot length does not fit in an int64 file offset"}
	}
	return nil
}

func (c Config) usablePageSize() int {
	return c.PageSize - c.ReservedBytes
}
