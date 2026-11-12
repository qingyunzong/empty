package lp1

import (
	"encoding/binary"
	"sync/atomic"
)

// Snapshot is an immutable, fully validated LP1 page. Snapshots retain only the
// page bytes, the header counts and a byte-read counter: no per-element offset
// table and no decoded values are stored long term.
type Snapshot struct {
	data     []byte
	count    uint64 // true element count established by scanning
	hdrCount uint16 // verbatim element count from the header

	// byteReads counts page bytes inspected by cursors after Open completed.
	byteReads atomic.Uint64
}

// Count returns the true number of elements established while scanning.
func (s *Snapshot) Count() uint64 { return s.count }

// HeaderCount returns the element count verbatim from the page header; it is
// 65535 for pages that declare an unknown count.
func (s *Snapshot) HeaderCount() uint16 { return s.hdrCount }

// Bytes returns a copy of the complete validated page.
func (s *Snapshot) Bytes() []byte {
	out := make([]byte, len(s.data))
	copy(out, s.data)
	return out
}

// ByteReads reports page bytes inspected by this snapshot's cursors since Open
// returned. Open is fully verified before the counter is exposed and never
// increments it.
func (s *Snapshot) ByteReads() uint64 { return s.byteReads.Load() }

// ResetByteReads zeroes the observable byte-read counter.
func (s *Snapshot) ResetByteReads() { s.byteReads.Store(0) }

// Head returns a cursor positioned before the first element.
func (s *Snapshot) Head() *Cursor {
	return &Cursor{snap: s, next: headerSize, end: len(s.data) - footerSize}
}

// Tail returns a cursor positioned after the last element.
func (s *Snapshot) Tail() *Cursor {
	return &Cursor{snap: s, next: headerSize, end: len(s.data) - footerSize}
}

// Cursor traverses exactly one snapshot. Cursors are constant-size and belong
// to the snapshot that created them; splice results carry independent cursors.
type Cursor struct {
	snap *Snapshot
	next int // forward boundary: first unread byte
	end  int // backward boundary: one past last unread byte
}

// Element is one traversal result: the typed value plus its physical extent.
type Element struct {
	Value       Value
	BodyStart   int
	BodyEnd     int // exclusive
	ElementEnd  int // exclusive; includes the reverse-length bytes
	BodyLength  int
	BacklenSize int
}

// Next advances forward from the head boundary. It returns false at the footer.
func (c *Cursor) Next() (Element, bool) {
	if c.next >= c.end {
		return Element{}, false
	}
	bodyStart := c.next
	view := &countedView{snap: c.snap}
	kind, num, payload, bodyLen, ok := scanBody(c.snap.data, bodyStart, c.end, view)
	if !ok {
		return Element{}, false
	}
	elemEnd, backLen, ok := resolveBacklen(c.snap.data, bodyStart, bodyLen, c.end, view)
	if !ok {
		return Element{}, false
	}
	c.next = elemEnd
	return makeElement(bodyStart, bodyLen, backLen, elemEnd, kind, num, payload), true
}

// Prev moves backward from the current boundary by reading the reverse-length
// field immediately before it. Nothing is re-scanned from the page header.
func (c *Cursor) Prev() (Element, bool) {
	if c.end <= headerSize || c.end <= c.next {
		return Element{}, false
	}
	view := &countedView{snap: c.snap}
	bodyStart, bodyLen, backLen, ok := readBacklenBackward(c.snap.data, c.end, view)
	if !ok {
		return Element{}, false
	}
	kind, num, payload, forwardLen, ok := scanBody(c.snap.data, bodyStart, c.end, view)
	if !ok || forwardLen != bodyLen {
		return Element{}, false
	}
	elemEnd := c.end
	c.end = bodyStart
	return makeElement(bodyStart, bodyLen, backLen, elemEnd, kind, num, payload), true
}

func makeElement(bodyStart, bodyLen, backLen, elemEnd int, kind Type, num int64, payload []byte) Element {
	el := Element{
		BodyStart:   bodyStart,
		BodyEnd:     bodyStart + bodyLen,
		ElementEnd:  elemEnd,
		BodyLength:  bodyLen,
		BacklenSize: backLen,
	}
	if kind == TypeInteger {
		el.Value = Integer(num)
	} else {
		el.Value = String(payload)
	}
	return el
}

// Open fully validates page and returns an immutable snapshot. The input is
// copied, so later caller mutation cannot affect the snapshot. No cursor is
// delivered on failure.
func Open(page []byte) (*Snapshot, error) {
	snap, err := validate(page, true)
	if err != nil {
		return nil, err
	}
	return snap, nil
}

// validate implements the full page verification. When copyInput is false the
// caller guarantees the slice is private to the package (a freshly built page).
func validate(page []byte, copyInput bool) (*Snapshot, error) {
	if len(page) < headerSize+footerSize {
		return nil, ErrMalformed
	}
	total := binary.LittleEndian.Uint32(page[0:4])
	if uint64(total) != uint64(len(page)) {
		return nil, ErrMalformed
	}
	if page[len(page)-1] != pageFooter {
		return nil, ErrMalformed
	}
	hdrCount := binary.LittleEndian.Uint16(page[4:6])

	data := page
	if copyInput {
		data = make([]byte, len(page))
		copy(data, page)
	}

	contentEnd := len(data) - footerSize
	off := headerSize
	var count uint64
	view := silentView{}
	for off < contentEnd {
		if data[off] == pageFooter {
			return nil, ErrMalformed // 0xff is only legal as the footer
		}
		bodyStart := off
		_, _, _, bodyLen, ok := scanBody(data, bodyStart, contentEnd, view)
		if !ok {
			return nil, ErrMalformed
		}
		elemEnd, _, ok := resolveBacklen(data, bodyStart, bodyLen, contentEnd, view)
		if !ok {
			return nil, ErrMalformed
		}
		off = elemEnd
		count++
	}
	if off != contentEnd {
		return nil, ErrMalformed
	}
	if hdrCount != unknownCount && uint64(hdrCount) != count {
		return nil, ErrMalformed
	}
	return &Snapshot{data: data, count: count, hdrCount: hdrCount}, nil
}

// Splice returns a new snapshot derived from s. Elements outside
// [startIndex, startIndex+deleteCount) keep their exact on-page bytes, including
// non-shortest encodings; they are copied as raw bytes rather than decoded and
// re-encoded.
//
// startIndex addresses elements in the old sequence and may equal Count to
// append. byteBudget is an inclusive maximum for the new total page size; zero
// means no budget beyond the uint32 format limit. On failure s and every cursor
// derived from it remain valid.
func (s *Snapshot) Splice(startIndex, deleteCount int, newValues []Value, byteBudget uint64) (*Snapshot, error) {
	if startIndex < 0 || uint64(startIndex) > s.count {
		return nil, ErrIndexOutOfRange
	}
	if deleteCount < 0 || uint64(startIndex)+uint64(deleteCount) > s.count {
		return nil, ErrIndexOutOfRange
	}

	encoded := make([][]byte, len(newValues))
	totalNew := uint64(0)
	for i := range newValues {
		body, err := EncodeValue(newValues[i])
		if err != nil {
			return nil, err
		}
		encoded[i] = encodeElement(body)
		totalNew += uint64(len(encoded[i]))
	}

	prefixEnd, err := s.elementOffset(startIndex)
	if err != nil {
		return nil, err
	}
	deletionEnd, err := s.elementOffset(startIndex + deleteCount)
	if err != nil {
		return nil, err
	}

	contentEnd := len(s.data) - footerSize
	prefixLen := uint64(prefixEnd - headerSize)
	suffixLen := uint64(contentEnd - deletionEnd)
	total := uint64(headerSize+footerSize) + prefixLen + totalNew + suffixLen
	if total > maxPageSize {
		return nil, ErrCapacity
	}
	if byteBudget > 0 && total > byteBudget {
		return nil, ErrCapacity
	}

	// All destination bytes live in a fresh allocation: no writable region is
	// shared with the old snapshot or any caller-provided slice.
	out := make([]byte, headerSize, total)
	out = append(out, s.data[headerSize:prefixEnd]...)
	for _, enc := range encoded {
		out = append(out, enc...)
	}
	out = append(out, s.data[deletionEnd:contentEnd]...)
	out = append(out, pageFooter)

	binary.LittleEndian.PutUint32(out[0:4], uint32(len(out)))
	newCount := s.count - uint64(deleteCount) + uint64(len(newValues))
	if newCount < unknownCount {
		binary.LittleEndian.PutUint16(out[4:6], uint16(newCount))
	} else {
		binary.LittleEndian.PutUint16(out[4:6], unknownCount)
	}

	return validate(out, false)
}

// elementOffset returns the page offset of the start of element idx, or the
// content end offset when idx equals the element count.
func (s *Snapshot) elementOffset(idx int) (int, error) {
	contentEnd := len(s.data) - footerSize
	off := headerSize
	for i := 0; i < idx; i++ {
		if off >= contentEnd {
			return 0, ErrIndexOutOfRange
		}
		_, _, _, bodyLen, ok := scanBody(s.data, off, contentEnd, silentView{})
		if !ok {
			return 0, ErrMalformed
		}
		elemEnd, _, ok := resolveBacklen(s.data, off, bodyLen, contentEnd, silentView{})
		if !ok {
			return 0, ErrMalformed
		}
		off = elemEnd
	}
	return off, nil
}
