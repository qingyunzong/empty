package dataeng_test

import (
	"errors"
	"fmt"
)

// The reference implementation in this file intentionally uses complete
// expanded word strings. It shares no dictionary representation or width
// bookkeeping with the production decoder.

type refCode struct {
	Code       uint16
	Width      int
	BitOffset  uint64
	Word       []byte
	NextAfter  int
	WidthAfter int
}

type refDecoded struct {
	Output []byte
	Codes  []refCode
}

type refState struct {
	early int

	width     int
	next      int
	prev      string
	prevValid bool
	firstDone bool
	ended     bool

	dict [4096]string
}

func newRefState(early int) *refState {
	return &refState{early: early, width: 9, next: 258}
}

func (r *refState) resetDictionary() {
	r.width = 9
	r.next = 258
	r.prev = ""
	r.prevValid = false
}

func (r *refState) step(code uint16) (word []byte, end bool, err error) {
	if r.ended {
		return nil, false, errors.New("ref: code after END")
	}

	if !r.firstDone {
		if code != 256 {
			return nil, false, errors.New("ref: first code must be CLEAR")
		}
		r.firstDone = true
		r.resetDictionary()
		return nil, false, nil
	}

	switch code {
	case 256:
		r.resetDictionary()
		return nil, false, nil
	case 257:
		r.ended = true
		return nil, true, nil
	}

	var w string
	switch {
	case code < 256:
		w = string([]byte{byte(code)})
	case code >= 258 && int(code) < r.next:
		w = r.dict[code]
		if w == "" {
			return nil, false, fmt.Errorf("ref: undefined code %d (next=%d)", code, r.next)
		}
	case int(code) == r.next && r.prevValid && r.next < 4096:
		w = r.prev + r.prev[:1]
	default:
		return nil, false, fmt.Errorf("ref: invalid code %d (next=%d, prevValid=%t)", code, r.next, r.prevValid)
	}

	if r.prevValid && r.next < 4096 {
		r.dict[r.next] = r.prev + w[:1]
		r.next++
		if r.width < 12 && r.next == (1<<uint(r.width))-r.early {
			r.width++
		}
	}
	r.prev = w
	r.prevValid = true
	return []byte(w), false, nil
}

type refBitReader struct {
	data []byte
	pos  int
}

func (b *refBitReader) remaining() int {
	return len(b.data)*8 - b.pos
}

func (b *refBitReader) read(width int) (uint16, bool) {
	if b.remaining() < width {
		return 0, false
	}
	var v uint16
	for i := 0; i < width; i++ {
		p := b.pos + i
		v = (v << 1) | uint16((b.data[p/8]>>uint(7-p%8))&1)
	}
	b.pos += width
	return v, true
}

func refDecode(data []byte, early int) (refDecoded, error) {
	state := newRefState(early)
	reader := refBitReader{data: data}
	var result refDecoded

	for {
		if reader.remaining() == 0 {
			return result, errors.New("ref: physical EOF without END")
		}
		if reader.remaining() < state.width {
			return result, fmt.Errorf("ref: truncated code: %d bits left, width %d", reader.remaining(), state.width)
		}

		offset := reader.pos
		width := state.width
		code, _ := reader.read(width)
		word, end, err := state.step(code)
		if err != nil {
			return result, err
		}
		record := refCode{
			Code:       code,
			Width:      width,
			BitOffset:  uint64(offset),
			Word:       append([]byte(nil), word...),
			NextAfter:  state.next,
			WidthAfter: state.width,
		}
		result.Codes = append(result.Codes, record)
		result.Output = append(result.Output, word...)
		if end {
			usedBytes := (reader.pos + 7) / 8
			if len(data) > usedBytes {
				return result, errors.New("ref: trailing bytes after END")
			}
			for pos := reader.pos; pos < usedBytes*8; pos++ {
				if (data[pos/8]>>uint(7-pos%8))&1 != 0 {
					return result, errors.New("ref: non-zero padding after END")
				}
			}
			return result, nil
		}
	}
}

type refBitWriter struct {
	data []byte
	cur  byte
	n    int
}

func (w *refBitWriter) write(code uint16, width int) {
	for i := width - 1; i >= 0; i-- {
		w.cur = (w.cur << 1) | byte((code>>uint(i))&1)
		w.n++
		if w.n == 8 {
			w.data = append(w.data, w.cur)
			w.cur = 0
			w.n = 0
		}
	}
}

func (w *refBitWriter) finish() []byte {
	if w.n != 0 {
		w.cur <<= uint(8 - w.n)
		w.data = append(w.data, w.cur)
		w.cur = 0
		w.n = 0
	}
	return w.data
}

// refPack chooses the width of every code from the reference decoder state.
// The production decoder's width state is never consulted.
func refPack(codes []uint16, early int) ([]byte, error) {
	state := newRefState(early)
	writer := refBitWriter{}
	for i, code := range codes {
		if state.ended {
			return nil, fmt.Errorf("ref: code %d follows END", i)
		}
		if int(code) >= (1 << uint(state.width)) {
			return nil, fmt.Errorf("ref: code %d does not fit width %d", code, state.width)
		}
		writer.write(code, state.width)
		_, end, err := state.step(code)
		if err != nil {
			return nil, err
		}
		if end && i != len(codes)-1 {
			return nil, errors.New("ref: codes after END")
		}
	}
	return writer.finish(), nil
}

// packFixedWidth is for deliberately malformed streams whose codes would not
// be accepted by the reference state machine. Tests that use it only involve
// the initial 9-bit state.
func packFixedWidth(codes []uint16, width int) []byte {
	writer := refBitWriter{}
	for _, code := range codes {
		writer.write(code, width)
	}
	return writer.finish()
}
