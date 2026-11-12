// Package fixture constructs standalone SQLite-style leaf cells and overflow
// pages for tests. It never writes or modifies a database snapshot.
package fixture

import (
	"encoding/binary"
	"fmt"

	"example.org/dataeng/q0323"
)

// Options controls cell construction. Zero values select automatic encodings
// and automatically sized page files.
type Options struct {
	// PayloadVarintWidth and RowIDVarintWidth force non-minimal encodings.
	// Zero chooses the shortest legal width. A requested width must be 1..9
	// and must have enough bits for the value.
	PayloadVarintWidth int
	RowIDVarintWidth   int

	// FirstOverflowPage overrides the default of CellPage+1.
	FirstOverflowPage uint64
	// TotalPages overrides the automatic file size. It must cover every page
	// touched by the cell and chain.
	TotalPages uint64

	// ExtraFinalLink points the last required overflow page at an unrelated
	// existing page. It is useful for the extra-page rejection test.
	ExtraFinalLink uint64

	PageFill         byte
	ReservedFill     byte
	OverflowTailFill byte
	CellTailFill     byte
}

// Layout is the page geometry and target-cell location.
type Layout struct {
	PageSize      int
	ReservedBytes int
	CellPage      uint64
	CellOffset    int
}

// Cell is a fully constructed page file and its complete payload reference.
type Cell struct {
	File              []byte
	PageSize          int
	ReservedBytes     int
	CellPage          uint64
	CellOffset        int
	CellLength        int
	Payload           []byte
	PayloadLength     uint64
	LocalLength       uint64
	FirstOverflowPage uint64
	OverflowPages     []uint64
	TotalPages        uint64
}

// Ref returns the exact target-cell descriptor.
func (c *Cell) Ref() dataeng.CellRef {
	return dataeng.CellRef{Page: c.CellPage, Offset: c.CellOffset, Length: c.CellLength}
}

// Config returns matching geometry with the requested budgets.
func (c *Cell) Config(headerBudget, chainBudget, projectionBudget uint64) dataeng.Config {
	return dataeng.Config{
		PageSize:             c.PageSize,
		ReservedBytes:        c.ReservedBytes,
		PageCount:            c.TotalPages,
		HeaderByteBudget:     headerBudget,
		ChainPageBudget:      chainBudget,
		ProjectionByteBudget: projectionBudget,
	}
}

// PageStart returns the byte offset of a one-based page in the fixture file.
func (c *Cell) PageStart(page uint64) (int64, error) {
	if page < 1 || page > c.TotalPages {
		return 0, fmt.Errorf("fixture: page %d outside [1,%d]", page, c.TotalPages)
	}
	return int64(page-1) * int64(c.PageSize), nil
}

// SetLink changes a page's 4-byte big-endian next-page link.
func SetLink(file []byte, pageSize int, page, next uint64) error {
	if page < 1 || pageSize <= 0 || int64(page)*int64(pageSize) > int64(len(file)) {
		return fmt.Errorf("fixture: page %d is outside the file", page)
	}
	if next > uint64(^uint32(0)) {
		return fmt.Errorf("fixture: link %d does not fit in 32 bits", next)
	}
	offset := int(page-1) * pageSize
	binary.BigEndian.PutUint32(file[offset:offset+4], uint32(next))
	return nil
}

// Truncate returns a copy shortened by n bytes, preserving the configured page
// count for a short-read test.
func (c *Cell) Truncate(n int) (*Cell, error) {
	if n < 0 || n > len(c.File) {
		return nil, fmt.Errorf("fixture: cannot truncate %d bytes from %d", n, len(c.File))
	}
	clone := *c
	clone.File = append([]byte(nil), c.File[:len(c.File)-n]...)
	return &clone, nil
}

// BuildCell constructs a valid page file containing the target cell and the
// exact overflow chain required by payload.
func BuildCell(layout Layout, rowID int64, payload []byte, opts Options) (*Cell, error) {
	if err := validateLayout(layout); err != nil {
		return nil, err
	}
	usable := layout.PageSize - layout.ReservedBytes
	pLength := uint64(len(payload))
	pVarint, rowVarint, local, overflow, cellLength, err := encodeCellParts(layout, rowID, pLength, opts)
	if err != nil {
		return nil, err
	}

	capacity := uint64(usable - 4)
	overflowPayload := pLength - local
	required := uint64(0)
	if overflowPayload > 0 {
		required = overflowPayload / capacity
		if overflowPayload%capacity != 0 {
			required++
		}
	}

	firstPage := opts.FirstOverflowPage
	if overflow {
		if firstPage == 0 {
			firstPage = layout.CellPage + 1
		}
		if firstPage < 1 {
			return nil, fmt.Errorf("fixture: first overflow page must be positive")
		}
	}
	overflowPages := make([]uint64, 0, required)
	for i := uint64(0); i < required; i++ {
		overflowPages = append(overflowPages, firstPage+i)
	}

	lastTouched := layout.CellPage
	if len(overflowPages) > 0 {
		if last := overflowPages[len(overflowPages)-1]; last > lastTouched {
			lastTouched = last
		}
	}
	if opts.ExtraFinalLink != 0 && opts.ExtraFinalLink > lastTouched {
		lastTouched = opts.ExtraFinalLink
	}
	totalPages := opts.TotalPages
	if totalPages == 0 {
		totalPages = lastTouched
	}
	if totalPages < lastTouched {
		return nil, fmt.Errorf("fixture: total pages %d does not cover page %d", totalPages, lastTouched)
	}
	if totalPages > uint64(int(^uint(0)>>1))/uint64(layout.PageSize) {
		return nil, fmt.Errorf("fixture: file length exceeds platform limits")
	}

	pageFill := opts.PageFill
	if pageFill == 0 {
		pageFill = 0xcc
	}
	reservedFill := opts.ReservedFill
	if reservedFill == 0 {
		reservedFill = 0xee
	}
	overflowTailFill := opts.OverflowTailFill
	if overflowTailFill == 0 {
		overflowTailFill = 0xa5
	}
	cellTailFill := opts.CellTailFill
	if cellTailFill == 0 {
		cellTailFill = 0xdd
	}

	file := make([]byte, int(totalPages)*layout.PageSize)
	for i := range file {
		file[i] = pageFill
	}
	for page := uint64(1); page <= totalPages; page++ {
		reservedStart := int(page-1)*layout.PageSize + usable
		for i := reservedStart; i < int(page)*layout.PageSize; i++ {
			file[i] = reservedFill
		}
	}

	cellStart := int(layout.CellPage-1)*layout.PageSize + layout.CellOffset
	for i := cellStart + cellLength; i < int(layout.CellPage-1)*layout.PageSize+usable; i++ {
		file[i] = cellTailFill
	}
	copy(file[cellStart:], pVarint)
	copy(file[cellStart+len(pVarint):], rowVarint)
	localStart := cellStart + len(pVarint) + len(rowVarint)
	copy(file[localStart:], payload[:local])
	if overflow {
		binary.BigEndian.PutUint32(file[localStart+int(local):], uint32(firstPage))
	}

	remaining := overflowPayload
	position := local
	for i, page := range overflowPages {
		pageStart := int(page-1) * layout.PageSize
		pageEnd := pageStart + usable
		for j := pageStart + 4 + int(minUint64(capacity, remaining)); j < pageEnd; j++ {
			file[j] = overflowTailFill
		}
		next := uint64(0)
		if i+1 < len(overflowPages) {
			next = overflowPages[i+1]
		} else {
			next = opts.ExtraFinalLink
		}
		binary.BigEndian.PutUint32(file[pageStart:pageStart+4], uint32(next))
		chunk := minUint64(capacity, remaining)
		copy(file[pageStart+4:pageStart+4+int(chunk)], payload[position:position+chunk])
		position += chunk
		remaining -= chunk
	}
	if remaining != 0 || position != pLength {
		return nil, fmt.Errorf("fixture: internal overflow construction mismatch")
	}

	return &Cell{
		File:              file,
		PageSize:          layout.PageSize,
		ReservedBytes:     layout.ReservedBytes,
		CellPage:          layout.CellPage,
		CellOffset:        layout.CellOffset,
		CellLength:        cellLength,
		Payload:           append([]byte(nil), payload...),
		PayloadLength:     pLength,
		LocalLength:       local,
		FirstOverflowPage: firstPage,
		OverflowPages:     append([]uint64(nil), overflowPages...),
		TotalPages:        totalPages,
	}, nil
}

// BuildDeclaredCell constructs only the target cell and its 4-byte pointer,
// using payloadLength in the cell varint without building a matching payload
// chain. It is intended for early budget and malformed-chain tests.
func BuildDeclaredCell(
	layout Layout,
	rowID int64,
	payloadLength uint64,
	firstOverflowPage uint64,
	opts Options,
) (*Cell, error) {
	if err := validateLayout(layout); err != nil {
		return nil, err
	}
	usable := layout.PageSize - layout.ReservedBytes
	pVarint, rowVarint, local, overflow, cellLength, err := encodeCellParts(layout, rowID, payloadLength, opts)
	if err != nil {
		return nil, err
	}
	if overflow && firstOverflowPage == 0 {
		firstOverflowPage = layout.CellPage + 1
	}
	lastTouched := layout.CellPage
	if firstOverflowPage > lastTouched {
		lastTouched = firstOverflowPage
	}
	totalPages := opts.TotalPages
	if totalPages == 0 {
		totalPages = lastTouched
	}
	if totalPages < lastTouched {
		return nil, fmt.Errorf("fixture: total pages %d does not cover page %d", totalPages, lastTouched)
	}
	if totalPages > uint64(int(^uint(0)>>1))/uint64(layout.PageSize) {
		return nil, fmt.Errorf("fixture: file length exceeds platform limits")
	}

	pageFill := opts.PageFill
	if pageFill == 0 {
		pageFill = 0xcc
	}
	reservedFill := opts.ReservedFill
	if reservedFill == 0 {
		reservedFill = 0xee
	}
	file := make([]byte, int(totalPages)*layout.PageSize)
	for i := range file {
		file[i] = pageFill
	}
	for page := uint64(1); page <= totalPages; page++ {
		reservedStart := int(page-1)*layout.PageSize + usable
		for i := reservedStart; i < int(page)*layout.PageSize; i++ {
			file[i] = reservedFill
		}
	}
	cellStart := int(layout.CellPage-1)*layout.PageSize + layout.CellOffset
	copy(file[cellStart:], pVarint)
	copy(file[cellStart+len(pVarint):], rowVarint)
	payloadStart := cellStart + len(pVarint) + len(rowVarint)
	if overflow {
		binary.BigEndian.PutUint32(file[payloadStart+int(local):], uint32(firstOverflowPage))
	}
	return &Cell{
		File:              file,
		PageSize:          layout.PageSize,
		ReservedBytes:     layout.ReservedBytes,
		CellPage:          layout.CellPage,
		CellOffset:        layout.CellOffset,
		CellLength:        cellLength,
		PayloadLength:     payloadLength,
		LocalLength:       local,
		FirstOverflowPage: firstOverflowPage,
		TotalPages:        totalPages,
	}, nil
}

func encodeCellParts(
	layout Layout,
	rowID int64,
	pLength uint64,
	opts Options,
) ([]byte, []byte, uint64, bool, int, error) {
	usable := layout.PageSize - layout.ReservedBytes
	local, overflow, err := LocalPayloadLength(pLength, usable)
	if err != nil {
		return nil, nil, 0, false, 0, err
	}
	pVarint, err := EncodeVarint(pLength, opts.PayloadVarintWidth)
	if err != nil {
		return nil, nil, 0, false, 0, fmt.Errorf("fixture: payload length: %w", err)
	}
	rowVarint, err := EncodeVarint(uint64(rowID), opts.RowIDVarintWidth)
	if err != nil {
		return nil, nil, 0, false, 0, fmt.Errorf("fixture: rowid: %w", err)
	}
	cellLength := len(pVarint) + len(rowVarint) + int(local)
	if overflow {
		cellLength += 4
	}
	if layout.CellOffset < 0 || layout.CellOffset+cellLength > usable {
		return nil, nil, 0, false, 0, fmt.Errorf("fixture: cell [%d,%d) is outside usable page bytes [0,%d)",
			layout.CellOffset, layout.CellOffset+cellLength, usable)
	}
	return pVarint, rowVarint, local, overflow, cellLength, nil
}

// CellStart returns the byte offset of the target cell in the fixture file.
func (c *Cell) CellStart() int64 {
	return int64(c.CellPage-1)*int64(c.PageSize) + int64(c.CellOffset)
}

// FirstOverflowPointerOffset returns the in-file offset of the cell's first
// overflow pointer, or false when the payload has no overflow pointer.
func (c *Cell) FirstOverflowPointerOffset() (int64, bool) {
	if c.PayloadLength <= uint64(c.PageSize-c.ReservedBytes-35) {
		return 0, false
	}
	return c.CellStart() + int64(c.CellLength) - 4, true
}

// LocalPayloadLength applies the required M/K local-payload rule.
func LocalPayloadLength(payloadLength uint64, usable int) (uint64, bool, error) {
	if usable < dataeng.MinUsablePageSize {
		return 0, false, fmt.Errorf("fixture: usable page size %d is below %d", usable, dataeng.MinUsablePageSize)
	}
	u := uint64(usable)
	threshold := u - 35
	if payloadLength <= threshold {
		return payloadLength, false, nil
	}
	m := ((u-12)*32)/255 - 23
	k := m + (payloadLength-m)%(u-4)
	if k <= threshold {
		return k, true, nil
	}
	return m, true, nil
}

// EncodeVarint encodes value with width 1..9, or the shortest width when width
// is zero. Widths greater than the shortest form deliberately produce legal
// non-minimal encodings.
func EncodeVarint(value uint64, width int) ([]byte, error) {
	if width == 0 {
		width = minimalWidth(value)
	}
	if width < 1 || width > 9 {
		return nil, fmt.Errorf("varint width %d is outside [1,9]", width)
	}
	bits := 7 * width
	if width == 9 {
		bits = 64
	}
	if bits < 64 && value >= uint64(1)<<uint(bits) {
		return nil, fmt.Errorf("varint width %d cannot represent %d", width, value)
	}

	out := make([]byte, width)
	if width == 9 {
		out[8] = byte(value)
		value >>= 8
		for i := 7; i >= 0; i-- {
			out[i] = byte(value&0x7f) | 0x80
			value >>= 7
		}
		return out, nil
	}
	for i := width - 1; i >= 0; i-- {
		out[i] = byte(value & 0x7f)
		if i < width-1 {
			out[i] |= 0x80
		}
		value >>= 7
	}
	if value != 0 {
		return nil, fmt.Errorf("varint width %d cannot represent the value", width)
	}
	return out, nil
}

func minimalWidth(value uint64) int {
	if value>>56 != 0 {
		return 9
	}
	for width := 1; width <= 8; width++ {
		if width == 8 || value < uint64(1)<<uint(7*width) {
			return width
		}
	}
	return 9
}

func validateLayout(layout Layout) error {
	if layout.PageSize < dataeng.MinPageSize || layout.PageSize > dataeng.MaxPageSize ||
		layout.PageSize&(layout.PageSize-1) != 0 {
		return fmt.Errorf("fixture: invalid page size %d", layout.PageSize)
	}
	if layout.ReservedBytes < 0 || layout.ReservedBytes >= layout.PageSize ||
		layout.PageSize-layout.ReservedBytes < dataeng.MinUsablePageSize {
		return fmt.Errorf("fixture: invalid reserved byte count %d", layout.ReservedBytes)
	}
	if layout.CellPage < 1 {
		return fmt.Errorf("fixture: cell page must be positive")
	}
	if layout.CellOffset < 0 {
		return fmt.Errorf("fixture: cell offset must be non-negative")
	}
	return nil
}

func minUint64(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}
