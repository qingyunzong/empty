package dataeng

import (
	"errors"
	"fmt"
)

// Status describes why Pull stopped and what the host should do next.
type Status uint8

const (
	// StatusNeedInput means that the decoder needs more compressed bytes.
	StatusNeedInput Status = iota

	// StatusNeedOutput means that decoded output is still buffered inside the
	// decoder, or that the caller's output budget was exhausted. Call Pull
	// again with a positive maxBytes value.
	StatusNeedOutput

	// StatusNeedInputOrOutput is returned by Pull(0) when there is no pending
	// output and not even one complete code is buffered. More input and more
	// output capacity are both potentially required before progress is
	// possible, so the host may Feed more bytes or call Pull with positive
	// capacity.
	StatusNeedInputOrOutput

	// StatusNeedFinish means that END and the physical tail have been validated,
	// but Finish has not yet been called. No further compressed bytes are
	// acceptable; the host must call Finish and then Pull again to receive
	// StatusEnd.
	StatusNeedFinish

	// StatusEnd means that a complete, finalised stream has been consumed and
	// all output has been delivered.
	StatusEnd

	// StatusFailed means that the stream entered a permanent failure state.
	// Result.Err and Decoder.Err are non-nil. Any bytes returned in the same
	// Pull are the valid output prefix produced before the error.
	StatusFailed
)

func (s Status) String() string {
	switch s {
	case StatusNeedInput:
		return "needInput"
	case StatusNeedOutput:
		return "needOutput"
	case StatusNeedInputOrOutput:
		return "needInputOrOutput"
	case StatusNeedFinish:
		return "needFinish"
	case StatusEnd:
		return "end"
	case StatusFailed:
		return "failed"
	default:
		return fmt.Sprintf("Status(%d)", uint8(s))
	}
}

var (
	// ErrInvalidEarlyChange is returned by NewDecoder unless earlyChange is 0
	// or 1.
	ErrInvalidEarlyChange = errors.New("dataeng: earlyChange must be 0 or 1")

	// ErrMissingClear is returned when the first code is not CLEAR.
	ErrMissingClear = errors.New("dataeng: first code is not CLEAR")

	// ErrInvalidCode is returned for an undefined dictionary code, including
	// code == next with an empty prev or when the dictionary is full.
	ErrInvalidCode = errors.New("dataeng: undefined dictionary code")

	// ErrWordTooLong is an internal safety check. Valid streams cannot reach it
	// because the dictionary can contain at most 3838 dynamic entries.
	ErrWordTooLong = errors.New("dataeng: dictionary word exceeds 4096 bytes")

	// ErrOutputLimit is returned before any byte of an ordinary word is
	// delivered when that whole word would exceed the host-provided total
	// output limit.
	ErrOutputLimit = errors.New("dataeng: output limit exceeded")

	// ErrMissingEnd is returned at physical EOF when no END code was present.
	ErrMissingEnd = errors.New("dataeng: physical EOF without END")

	// ErrTruncatedCode is returned at physical EOF when fewer than one code
	// width remains, or when a code is otherwise incomplete.
	ErrTruncatedCode = errors.New("dataeng: truncated code at physical EOF")

	// ErrNonZeroPadding is returned when the unused low bits of the physical
	// byte containing END are not all zero.
	ErrNonZeroPadding = errors.New("dataeng: non-zero bits after END")

	// ErrTrailingData is returned when physical bytes follow the byte
	// containing END.
	ErrTrailingData = errors.New("dataeng: trailing bytes after END")

	// ErrFeedAfterFinish is returned when Feed is called after Finish. The
	// decoder state is not altered by that call.
	ErrFeedAfterFinish = errors.New("dataeng: Feed called after Finish")

	// ErrInvalidMaxBytes is returned for a negative Pull argument. The decoder
	// enters its permanent failure state for this host-contract violation.
	ErrInvalidMaxBytes = errors.New("dataeng: negative maxBytes")
)

// Source identifies the compressed dictionary code and the byte range within
// its expanded word that produced an output segment.
//
// BitOffset is absolute from the start of the physical compressed stream.
// BitWidth is the code width in effect when the code was read. WordOffset is
// zero-based within the fully expanded word, and WordLength is the full length
// of that word. Repeated Pull calls that deliver successive pieces of the same
// word report the same Code, BitOffset, BitWidth and WordLength, with
// WordOffset advancing.
type Source struct {
	Code       int
	BitOffset  uint64
	BitWidth   uint8
	WordOffset int
	WordLength int
}

// Segment describes one contiguous output fragment and its source. Offset and
// Length locate the fragment in Result.Data.
type Segment struct {
	Offset int
	Length int
	Source Source
}

// Result is the result of one Pull call.
//
// Data contains every byte produced by this call. Segments partition Data by
// source word, in order. Status tells the host why Pull stopped. Err is non-nil
// exactly when Status is StatusFailed.
type Result struct {
	Data     []byte
	Segments []Segment
	Status   Status
	Err      error
}

const (
	clearCode = 256
	endCode   = 257
	firstFree = 258
	maxCodes  = 4096
)

type pendingWord struct {
	data      []byte
	pos       int
	code      int
	bitOffset uint64
	bitWidth  uint8
}

// Decoder is an incremental decoder for the wide-LZW stream described in the
// package documentation. It is not safe for concurrent use.
type Decoder struct {
	earlyChange int
	outputLimit uint64

	// Compressed input. bitBase is the absolute bit offset of buf[0].
	buf     []byte
	bitPos  int
	bitBase uint64

	width     int
	next      int
	prevCode  int
	prevValid bool

	// Dictionary representation: no expanded strings are retained.
	prefix [maxCodes]int
	last   [maxCodes]byte
	length [maxCodes]int
	first  [maxCodes]byte

	firstCodeDone bool
	endSeen       bool
	finishCalled  bool
	failed        bool
	err           error

	pending  *pendingWord
	produced uint64
}

// NewDecoder creates a decoder.
//
// earlyChange must be 0 or 1 and selects the decoder's width-increase rule:
// after inserting a word, width increases when
//
//	next == (1 << width) - earlyChange
//
// outputLimit is the maximum total number of decoded bytes accepted from the
// stream. It is checked against the full length of each ordinary word before
// any byte of that word is delivered or any dictionary entry is inserted.
func NewDecoder(earlyChange int, outputLimit uint64) (*Decoder, error) {
	if earlyChange != 0 && earlyChange != 1 {
		return nil, ErrInvalidEarlyChange
	}

	d := &Decoder{
		earlyChange: earlyChange,
		outputLimit: outputLimit,
		width:       9,
		next:        firstFree,
		prevCode:    -1,
	}
	for i := 0; i < 256; i++ {
		d.last[i] = byte(i)
		d.first[i] = byte(i)
		d.length[i] = 1
	}
	return d, nil
}

// Feed supplies more compressed bytes. Feed only buffers input; decoding is
// performed by Pull. Feed after Finish, after END, or after a failure returns
// an error (and any bytes following END put the decoder into its failure
// state).
func (d *Decoder) Feed(p []byte) error {
	if d.failed {
		return d.err
	}
	if d.finishCalled {
		return ErrFeedAfterFinish
	}
	if d.endSeen {
		if len(p) != 0 {
			d.fail(ErrTrailingData)
			return d.err
		}
		return nil
	}
	d.buf = append(d.buf, p...)
	return nil
}

// Finish marks the physical end of input. It does not discard buffered output:
// the host must continue calling Pull until StatusEnd or StatusFailed. It is
// idempotent. Missing END, a partial code, non-zero END padding and trailing
// bytes are diagnosed by Pull once the remaining input/output has been
// processed. Calling Finish on an already failed decoder returns its error.
func (d *Decoder) Finish() error {
	if d.failed {
		return d.err
	}
	d.finishCalled = true
	return nil
}

// Err returns the permanent failure error, or nil if the decoder has not
// failed.
func (d *Decoder) Err() error {
	return d.err
}

func (d *Decoder) fail(err error) {
	if !d.failed {
		d.failed = true
		d.err = err
		d.pending = nil
	}
}

func (d *Decoder) failedResult(prefix Result) Result {
	prefix.Status = StatusFailed
	prefix.Err = d.err
	return prefix
}

func (d *Decoder) bitsAvailable() int {
	return len(d.buf)*8 - d.bitPos
}

func (d *Decoder) bitAt(pos int) uint16 {
	return uint16((d.buf[pos/8] >> uint(7-pos%8)) & 1)
}

func (d *Decoder) absoluteBitPos() uint64 {
	return d.bitBase + uint64(d.bitPos)
}

func (d *Decoder) peekCode() (uint16, bool) {
	if d.bitsAvailable() < d.width {
		return 0, false
	}
	var code uint16
	for i := 0; i < d.width; i++ {
		code = (code << 1) | d.bitAt(d.bitPos+i)
	}
	return code, true
}

// compact drops whole consumed bytes while preserving bit alignment.
func (d *Decoder) compact() {
	if d.bitPos < 8 {
		return
	}
	n := d.bitPos / 8
	d.buf = d.buf[n:]
	d.bitBase += uint64(n) * 8
	d.bitPos -= n * 8
}

func (d *Decoder) clearDictionary() {
	d.width = 9
	d.next = firstFree
	d.prevCode = -1
	d.prevValid = false
}

func (d *Decoder) wordInfo(code uint16) (wordLen int, entryCode int, special bool, err error) {
	c := int(code)
	switch {
	case c < 256:
		return 1, c, false, nil
	case c >= firstFree && c < d.next:
		return d.length[c], c, false, nil
	case c == d.next && d.prevValid && d.next < maxCodes:
		return d.length[d.prevCode] + 1, c, true, nil
	default:
		return 0, 0, false, fmt.Errorf("%w: %d (next=%d, prevValid=%t)", ErrInvalidCode, c, d.next, d.prevValid)
	}
}

// expandWord expands code or the KwKwK word for special into dst. dst must
// have exactly wordLen bytes.
func (d *Decoder) expandWord(code int, special bool, dst []byte) {
	if special {
		prevLen := d.length[d.prevCode]
		cur := d.prevCode
		for i := prevLen - 1; i >= 0; i-- {
			dst[i] = d.last[cur]
			cur = d.prefix[cur]
		}
		dst[prevLen] = d.first[d.prevCode]
		return
	}
	cur := code
	for i := len(dst) - 1; i >= 0; i-- {
		dst[i] = d.last[cur]
		cur = d.prefix[cur]
	}
}

func (d *Decoder) commitWord(entryCode int, wordFirst byte) {
	if d.prevValid && d.next < maxCodes {
		if d.length[d.prevCode]+1 > 4096 {
			d.fail(ErrWordTooLong)
			return
		}
		idx := d.next
		d.prefix[idx] = d.prevCode
		d.last[idx] = wordFirst
		d.first[idx] = d.first[d.prevCode]
		d.length[idx] = d.length[d.prevCode] + 1
		d.next++

		if d.width < 12 && d.next == (1<<uint(d.width))-d.earlyChange {
			d.width++
		}
	}
	d.prevCode = entryCode
	d.prevValid = true
}

// validateEndTail consumes no more input. It verifies the zero padding in the
// physical byte containing END and rejects any additional physical bytes.
func (d *Decoder) validateEndTail() bool {
	usedBytes := (d.bitPos + 7) / 8
	if len(d.buf) > usedBytes {
		d.fail(ErrTrailingData)
		return false
	}
	for pos := d.bitPos; pos < usedBytes*8; pos++ {
		if d.bitAt(pos) != 0 {
			d.fail(ErrNonZeroPadding)
			return false
		}
	}
	d.endSeen = true
	return true
}

func (d *Decoder) eofFailure() Result {
	if d.bitsAvailable() == 0 {
		d.fail(ErrMissingEnd)
	} else {
		d.fail(ErrTruncatedCode)
	}
	return Result{Status: StatusFailed, Err: d.err}
}

// Pull decodes at most maxBytes output bytes.
//
// maxBytes must be non-negative. Pull(0) makes no decoding progress: it never
// consumes an ordinary code and never inserts a dictionary word. It may report
// an already established terminal state (StatusEnd or StatusFailed), pending
// output (StatusNeedOutput), StatusNeedFinish, or StatusNeedInputOrOutput when
// zero capacity prevents the decoder from deciding whether input or output is
// needed first.
//
// If an ordinary code is available but its full word would exceed the total
// output limit, Pull fails before delivering any part of that word. If output
// capacity runs out in the middle of a word, the suffix is retained and a
// later Pull continues it without re-inserting the word or reading the next
// code. CLEAR and END are never expanded as word data.
func (d *Decoder) Pull(maxBytes int) Result {
	if maxBytes < 0 {
		d.fail(ErrInvalidMaxBytes)
		return d.failedResult(Result{})
	}
	if d.failed {
		return d.failedResult(Result{})
	}

	if d.pending == nil && d.endSeen {
		if d.finishCalled {
			return Result{Status: StatusEnd}
		}
		return Result{Status: StatusNeedFinish}
	}

	if maxBytes == 0 {
		if d.pending != nil {
			return Result{Status: StatusNeedOutput}
		}
		if d.finishCalled {
			if d.bitsAvailable() < d.width {
				return d.eofFailure()
			}
			// A complete code is buffered, but Pull(0) may not consume an
			// ordinary code; only output capacity can make progress.
			return Result{Status: StatusNeedOutput}
		}
		if d.bitsAvailable() >= d.width {
			// A complete code is already buffered. Capacity is the only
			// immediate blocker, even though Pull(0) will not consume it.
			return Result{Status: StatusNeedOutput}
		}
		return Result{Status: StatusNeedInputOrOutput}
	}

	var res Result
	remaining := maxBytes

	for {
		if d.failed {
			return d.failedResult(res)
		}

		if d.pending != nil {
			p := d.pending
			n := len(p.data) - p.pos
			if n > remaining {
				n = remaining
			}
			if n > 0 {
				start := len(res.Data)
				res.Data = append(res.Data, p.data[p.pos:p.pos+n]...)
				res.Segments = append(res.Segments, Segment{
					Offset: start,
					Length: n,
					Source: Source{
						Code:       p.code,
						BitOffset:  p.bitOffset,
						BitWidth:   p.bitWidth,
						WordOffset: p.pos,
						WordLength: len(p.data),
					},
				})
				p.pos += n
				remaining -= n
			}
			if p.pos == len(p.data) {
				d.pending = nil
			} else {
				res.Status = StatusNeedOutput
				return res
			}
		}

		if remaining == 0 {
			res.Status = StatusNeedOutput
			return res
		}

		if d.endSeen {
			if d.finishCalled {
				res.Status = StatusEnd
			} else {
				res.Status = StatusNeedFinish
			}
			return res
		}

		d.compact()

		code, ok := d.peekCode()
		if !ok {
			if d.finishCalled {
				failed := d.eofFailure()
				failed.Data = res.Data
				failed.Segments = res.Segments
				return failed
			}
			res.Status = StatusNeedInput
			return res
		}

		startBit := d.absoluteBitPos()
		width := d.width
		d.bitPos += width

		if !d.firstCodeDone {
			if code != clearCode {
				d.fail(ErrMissingClear)
				return d.failedResult(res)
			}
			d.firstCodeDone = true
			d.clearDictionary()
			continue
		}

		switch code {
		case clearCode:
			d.clearDictionary()
			continue

		case endCode:
			if !d.validateEndTail() {
				return d.failedResult(res)
			}
			if d.finishCalled {
				res.Status = StatusEnd
			} else {
				res.Status = StatusNeedFinish
			}
			return res

		default:
			wordLen, entryCode, special, err := d.wordInfo(code)
			if err != nil {
				d.fail(err)
				return d.failedResult(res)
			}
			if wordLen > 4096 {
				d.fail(ErrWordTooLong)
				return d.failedResult(res)
			}

			// The whole word must fit before any byte is delivered or
			// dictionary state is changed.
			if d.produced > d.outputLimit ||
				uint64(wordLen) > d.outputLimit-d.produced {
				d.fail(ErrOutputLimit)
				return d.failedResult(res)
			}

			word := make([]byte, wordLen)
			d.expandWord(entryCode, special, word)
			d.commitWord(entryCode, word[0])
			if d.failed {
				return d.failedResult(res)
			}
			d.produced += uint64(wordLen)

			d.pending = &pendingWord{
				data:      word,
				code:      entryCode,
				bitOffset: startBit,
				bitWidth:  uint8(width),
			}
			continue
		}
	}
}
