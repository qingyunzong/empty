package dataeng_test

import (
	"bytes"
	"errors"
	"math"
	"testing"

	dataeng "example.org/dataeng/q0321"
)

func mustRefPack(t *testing.T, codes []uint16, early int) []byte {
	t.Helper()
	data, err := refPack(codes, early)
	if err != nil {
		t.Fatalf("refPack: %v", err)
	}
	return data
}

func mustRefDecode(t *testing.T, data []byte, early int) refDecoded {
	t.Helper()
	ref, err := refDecode(data, early)
	if err != nil {
		t.Fatalf("refDecode: %v", err)
	}
	return ref
}

func ordinaryRefCodes(ref refDecoded) []refCode {
	var out []refCode
	for _, code := range ref.Codes {
		if len(code.Word) != 0 {
			out = append(out, code)
		}
	}
	return out
}

func newTestDecoder(t *testing.T, early int, limit uint64, stream []byte) *dataeng.Decoder {
	t.Helper()
	dec, err := dataeng.NewDecoder(early, limit)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	if err := dec.Feed(stream); err != nil {
		t.Fatalf("Feed: %v", err)
	}
	if err := dec.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return dec
}

func pullUntilDone(t *testing.T, dec *dataeng.Decoder, maxBytes int) ([]byte, []dataeng.Result) {
	t.Helper()
	var output []byte
	var results []dataeng.Result
	for {
		result := dec.Pull(maxBytes)
		results = append(results, result)
		output = append(output, result.Data...)
		switch result.Status {
		case dataeng.StatusEnd:
			return output, results
		case dataeng.StatusFailed:
			t.Fatalf("decoder failed: %v (delivered prefix %q)", result.Err, output)
		case dataeng.StatusNeedInput:
			t.Fatalf("finished stream unexpectedly needs input")
		case dataeng.StatusNeedOutput, dataeng.StatusNeedFinish:
			if result.Status == dataeng.StatusNeedFinish {
				t.Fatalf("Finish was called but decoder still needs finish")
			}
			if len(result.Data) == 0 && maxBytes != 0 {
				continue
			}
		default:
			t.Fatalf("unexpected status %v", result.Status)
		}
	}
}

func TestSmallCodeByCode(t *testing.T) {
	// Base words, ordinary dynamic words, and a KwKwK code (262 == next).
	codes := []uint16{256, 65, 66, 258, 67, 259, 262, 257}

	for _, early := range []int{0, 1} {
		t.Run(statusName(early), func(t *testing.T) {
			stream := mustRefPack(t, codes, early)
			ref := mustRefDecode(t, stream, early)
			dec := newTestDecoder(t, early, 1<<20, stream)

			output, results := pullUntilDone(t, dec, 1<<20)
			if !bytes.Equal(output, ref.Output) {
				t.Fatalf("output = %q, want %q", output, ref.Output)
			}
			if len(results) == 0 || results[len(results)-1].Status != dataeng.StatusEnd {
				t.Fatalf("final status = %v", results[len(results)-1].Status)
			}

			ordinary := ordinaryRefCodes(ref)
			var segments []dataeng.Segment
			for _, result := range results {
				segments = append(segments, result.Segments...)
			}
			if len(segments) != len(ordinary) {
				t.Fatalf("got %d segments, want %d", len(segments), len(ordinary))
			}
			outputOffset := 0
			for i, segment := range segments {
				want := ordinary[i]
				if segment.Offset != outputOffset {
					t.Fatalf("segment %d offset=%d", i, segment.Offset)
				}
				if segment.Length != len(want.Word) {
					t.Fatalf("segment %d length=%d want %d", i, segment.Length, len(want.Word))
				}
				src := segment.Source
				if src.Code != int(want.Code) ||
					src.BitOffset != want.BitOffset ||
					int(src.BitWidth) != want.Width ||
					src.WordOffset != 0 ||
					src.WordLength != len(want.Word) {
					t.Fatalf("segment %d source=%+v, want code=%d off=%d width=%d wordLen=%d",
						i, src, want.Code, want.BitOffset, want.Width, len(want.Word))
				}
				outputOffset += len(want.Word)
			}

			// The reference state machine itself demonstrates the dictionary
			// numbers and exact width switch point for this small stream.
			for i := 1; i < len(ref.Codes); i++ {
				if ref.Codes[i].Width != ref.Codes[i-1].WidthAfter {
					t.Fatalf("reference width discontinuity at code %d", i)
				}
			}
			if ref.Codes[6].Code != 262 || ref.Codes[6].NextAfter != 263 {
				t.Fatalf("KwKwK code/next = %d/%d", ref.Codes[6].Code, ref.Codes[6].NextAfter)
			}
		})
	}
}

func statusName(early int) string {
	if early == 0 {
		return "early0"
	}
	return "early1"
}

func boundaryCodes(threshold int, ordinaryCount int) []uint16 {
	codes := []uint16{256}
	for i := 0; i < ordinaryCount; i++ {
		codes = append(codes, uint16(32+i%95))
	}
	return codes
}

func TestWidthBoundaryWithClearAfterSwitch(t *testing.T) {
	for _, early := range []int{0, 1} {
		for _, baseThreshold := range []int{512, 1024, 2048} {
			threshold := baseThreshold - early // earlyChange raises the switch by one next value
			oldWidth := 9
			if baseThreshold >= 2048 {
				oldWidth = 11
			} else if baseThreshold >= 1024 {
				oldWidth = 10
			}
			ordinaryCount := threshold - 257
			codes := boundaryCodes(threshold, ordinaryCount)
			codes = append(codes, 256, 65, 66, 258, 257)

			t.Run(statusName(early)+"/"+itoa(threshold), func(t *testing.T) {
				stream := mustRefPack(t, codes, early)
				ref := mustRefDecode(t, stream, early)

				var switchIndex = -1
				for i, code := range ref.Codes {
					if code.NextAfter == threshold && code.WidthAfter == oldWidth+1 {
						switchIndex = i
						break
					}
				}
				if switchIndex < 0 {
					t.Fatalf("reference did not switch width at next=%d", threshold)
				}
				if ref.Codes[switchIndex].Width != oldWidth {
					t.Fatalf("trigger code width=%d, want %d", ref.Codes[switchIndex].Width, oldWidth)
				}
				if switchIndex+1 >= len(ref.Codes) || ref.Codes[switchIndex+1].Width != oldWidth+1 {
					t.Fatalf("CLEAR immediately after switch was not read at width %d", oldWidth+1)
				}
				if ref.Codes[switchIndex+1].Code != 256 {
					t.Fatalf("code after switch = %d, want CLEAR", ref.Codes[switchIndex+1].Code)
				}

				dec := newTestDecoder(t, early, 1<<20, stream)
				output, results := pullUntilDone(t, dec, 1<<20)
				if !bytes.Equal(output, ref.Output) {
					t.Fatalf("boundary output mismatch: got %d bytes, want %d", len(output), len(ref.Output))
				}
				assertSourcesMatch(t, results, ref)
			})
		}
	}
}

func TestWidthBoundaryWithClearBeforeSwitch(t *testing.T) {
	for _, early := range []int{0, 1} {
		for _, baseThreshold := range []int{512, 1024, 2048} {
			threshold := baseThreshold - early
			oldWidth := 9
			if baseThreshold >= 2048 {
				oldWidth = 11
			} else if baseThreshold >= 1024 {
				oldWidth = 10
			}
			ordinaryCount := threshold - 258 // stop one insertion short of the switch
			codes := boundaryCodes(threshold, ordinaryCount)
			codes = append(codes, 256, 65, 66, 258, 257)

			t.Run(statusName(early)+"/"+itoa(threshold), func(t *testing.T) {
				stream := mustRefPack(t, codes, early)
				ref := mustRefDecode(t, stream, early)

				clearIndex := ordinaryCount + 1
				if ref.Codes[clearIndex].Code != 256 || ref.Codes[clearIndex].Width != oldWidth {
					t.Fatalf("pre-switch CLEAR width=%d code=%d, want width %d",
						ref.Codes[clearIndex].Width, ref.Codes[clearIndex].Code, oldWidth)
				}
				if ref.Codes[clearIndex].WidthAfter != 9 {
					t.Fatalf("CLEAR did not restore width 9")
				}

				dec := newTestDecoder(t, early, 1<<20, stream)
				output, results := pullUntilDone(t, dec, 1<<20)
				if !bytes.Equal(output, ref.Output) {
					t.Fatalf("boundary output mismatch: got %d bytes, want %d", len(output), len(ref.Output))
				}
				assertSourcesMatch(t, results, ref)
			})
		}
	}
}

func TestKwKwKReadsNewWidthAtSwitch(t *testing.T) {
	for _, early := range []int{0, 1} {
		for _, baseThreshold := range []int{512, 1024, 2048} {
			threshold := baseThreshold - early
			ordinaryCount := threshold - 257
			codes := boundaryCodes(threshold, ordinaryCount)
			// next == threshold, so this is a legal KwKwK code read at the
			// newly selected width.
			codes = append(codes, uint16(threshold), 256, 65, 66, 258, 257)

			t.Run(statusName(early)+"/"+itoa(threshold), func(t *testing.T) {
				stream := mustRefPack(t, codes, early)
				ref := mustRefDecode(t, stream, early)
				kwIndex := ordinaryCount + 1
				if ref.Codes[kwIndex].Code != uint16(threshold) ||
					ref.Codes[kwIndex].Width != ref.Codes[kwIndex-1].WidthAfter ||
					ref.Codes[kwIndex].NextAfter != threshold+1 {
					t.Fatalf("KwKwK at switch: %+v", ref.Codes[kwIndex])
				}

				dec := newTestDecoder(t, early, math.MaxUint64, stream)
				output, results := pullUntilDone(t, dec, 1<<20)
				if !bytes.Equal(output, ref.Output) {
					t.Fatalf("output mismatch at switch KwKwK")
				}
				assertSourcesMatch(t, results, ref)
			})
		}
	}
}

func assertSourcesMatch(t *testing.T, results []dataeng.Result, ref refDecoded) {
	t.Helper()
	ordinary := ordinaryRefCodes(ref)
	var segments []dataeng.Segment
	for _, result := range results {
		segments = append(segments, result.Segments...)
	}
	if len(segments) != len(ordinary) {
		t.Fatalf("got %d source segments, want %d", len(segments), len(ordinary))
	}
	for i, segment := range segments {
		want := ordinary[i]
		if segment.Source.Code != int(want.Code) ||
			segment.Source.BitOffset != want.BitOffset ||
			int(segment.Source.BitWidth) != want.Width ||
			segment.Source.WordLength != len(want.Word) ||
			segment.Source.WordOffset != 0 ||
			segment.Length != len(want.Word) {
			t.Fatalf("segment %d source=%+v length=%d, want code=%d off=%d width=%d wordLen=%d",
				i, segment.Source, segment.Length, want.Code, want.BitOffset, want.Width, len(want.Word))
		}
	}
}

func assertFragmentedSourcesMatch(t *testing.T, results []dataeng.Result, ref refDecoded) {
	t.Helper()
	ordinary := ordinaryRefCodes(ref)
	var segments []dataeng.Segment
	for _, result := range results {
		segments = append(segments, result.Segments...)
	}
	segmentIndex := 0
	for wordIndex, want := range ordinary {
		delivered := 0
		for delivered < len(want.Word) {
			if segmentIndex >= len(segments) {
				t.Fatalf("missing source fragments for word %d", wordIndex)
			}
			segment := segments[segmentIndex]
			segmentIndex++
			if segment.Source.Code != int(want.Code) ||
				segment.Source.BitOffset != want.BitOffset ||
				int(segment.Source.BitWidth) != want.Width ||
				segment.Source.WordLength != len(want.Word) ||
				segment.Source.WordOffset != delivered {
				t.Fatalf("word %d fragment source=%+v, want code=%d off=%d width=%d wordLen=%d wordOffset=%d",
					wordIndex, segment.Source, want.Code, want.BitOffset, want.Width, len(want.Word), delivered)
			}
			delivered += segment.Length
		}
		if delivered != len(want.Word) {
			t.Fatalf("word %d fragments delivered %d bytes, want %d", wordIndex, delivered, len(want.Word))
		}
	}
	if segmentIndex != len(segments) {
		t.Fatalf("%d unexpected source fragments", len(segments)-segmentIndex)
	}
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}

func TestIllegalFirstKwKwK(t *testing.T) {
	// CLEAR followed by code 258 == next while prev is empty.
	stream := packFixedWidth([]uint16{256, 258}, 9)
	dec := newTestDecoder(t, 0, 100, stream)
	result := dec.Pull(100)
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrInvalidCode) {
		t.Fatalf("status=%v err=%v, want invalid-code failure", result.Status, result.Err)
	}
	if len(result.Data) != 0 {
		t.Fatalf("illegal KwKwK produced %q", result.Data)
	}

	// The same shape after a repeated CLEAR must also fail.
	stream = packFixedWidth([]uint16{256, 256, 258}, 9)
	dec = newTestDecoder(t, 1, 100, stream)
	result = dec.Pull(100)
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrInvalidCode) {
		t.Fatalf("repeated-CLEAR illegal KwKwK: status=%v err=%v", result.Status, result.Err)
	}
}

func TestLegalKwKwK(t *testing.T) {
	codes := []uint16{256, 65, 258, 259, 257}
	for _, early := range []int{0, 1} {
		stream := mustRefPack(t, codes, early)
		ref := mustRefDecode(t, stream, early)
		dec := newTestDecoder(t, early, 1000, stream)
		output, results := pullUntilDone(t, dec, 1000)
		if !bytes.Equal(output, ref.Output) {
			t.Fatalf("early=%d output=%q want %q", early, output, ref.Output)
		}
		if string(output) != "AAAAAA" {
			t.Fatalf("early=%d legal KwKwK output=%q", early, output)
		}
		assertSourcesMatch(t, results, ref)
	}
}

func TestFullDictionaryKeepsReading(t *testing.T) {
	// 3839 ordinary codes after CLEAR make next reach 4096.
	codes := make([]uint16, 0, 3860)
	codes = append(codes, 256)
	for i := 0; i < 3839; i++ {
		codes = append(codes, uint16(i%256))
	}
	// 300 would be undefined if the decoder had cleared implicitly. 4000 is
	// also an existing dynamic code at a full dictionary.
	codes = append(codes, 100, 200, 300, 4000, 257)

	for _, early := range []int{0, 1} {
		stream := mustRefPack(t, codes, early)
		ref := mustRefDecode(t, stream, early)

		fullStart := 1 + 3839
		for i := fullStart; i < len(ref.Codes); i++ {
			if ref.Codes[i].NextAfter != 4096 {
				t.Fatalf("early=%d next after full at code index %d = %d", early, i, ref.Codes[i].NextAfter)
			}
			if ref.Codes[i].Width != 12 {
				t.Fatalf("early=%d width after full at code index %d = %d", early, i, ref.Codes[i].Width)
			}
		}

		dec := newTestDecoder(t, early, 1<<20, stream)
		output, results := pullUntilDone(t, dec, 1<<20)
		if !bytes.Equal(output, ref.Output) {
			t.Fatalf("early=%d full-dictionary output mismatch: got %d want %d", early, len(output), len(ref.Output))
		}
		assertSourcesMatch(t, results, ref)
	}
}

func TestKwKwKAtLastDictionarySlot(t *testing.T) {
	// 3838 ordinary codes put next at 4095. Code 4095 is then a legal
	// code==next KwKwK and fills the final slot.
	codes := make([]uint16, 0, 3844)
	codes = append(codes, 256)
	for i := 0; i < 3838; i++ {
		codes = append(codes, uint16(i%256))
	}
	codes = append(codes, 4095, 65, 257)

	for _, early := range []int{0, 1} {
		stream := mustRefPack(t, codes, early)
		ref := mustRefDecode(t, stream, early)
		lastIndex := 1 + 3838
		if ref.Codes[lastIndex].Code != 4095 ||
			ref.Codes[lastIndex].NextAfter != 4096 ||
			ref.Codes[lastIndex].WidthAfter != 12 {
			t.Fatalf("last-slot KwKwK: %+v", ref.Codes[lastIndex])
		}
		dec := newTestDecoder(t, early, math.MaxUint64, stream)
		output, results := pullUntilDone(t, dec, 1<<20)
		if !bytes.Equal(output, ref.Output) {
			t.Fatalf("early=%d last-slot output mismatch", early)
		}
		assertSourcesMatch(t, results, ref)
	}
}

func TestFeedEveryByteIncrementally(t *testing.T) {
	codes := boundaryCodes(512, 255)
	codes = append(codes, 256, 65, 66, 258, 257)

	stream := mustRefPack(t, codes, 0)
	ref := mustRefDecode(t, stream, 0)
	dec, err := dataeng.NewDecoder(0, 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	var output []byte
	var results []dataeng.Result
	for _, b := range stream {
		if err := dec.Feed([]byte{b}); err != nil {
			t.Fatalf("Feed byte: %v", err)
		}
		for {
			result := dec.Pull(3)
			results = append(results, result)
			output = append(output, result.Data...)
			switch result.Status {
			case dataeng.StatusNeedInput:
				goto nextByte
			case dataeng.StatusNeedOutput:
				continue
			case dataeng.StatusNeedFinish:
				goto nextByte
			case dataeng.StatusEnd:
				t.Fatalf("END before Finish")
			case dataeng.StatusFailed:
				t.Fatalf("failed while feeding: %v", result.Err)
			}
		}
	nextByte:
	}
	if err := dec.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	for {
		result := dec.Pull(7)
		results = append(results, result)
		output = append(output, result.Data...)
		switch result.Status {
		case dataeng.StatusEnd:
			if !bytes.Equal(output, ref.Output) {
				t.Fatalf("byte-fed output mismatch: got %d want %d", len(output), len(ref.Output))
			}
			assertFragmentedSourcesMatch(t, results, ref)
			return
		case dataeng.StatusNeedOutput:
			continue
		case dataeng.StatusFailed:
			t.Fatalf("failed after Finish: %v", result.Err)
		case dataeng.StatusNeedInput, dataeng.StatusNeedFinish:
			t.Fatalf("sealed stream returned %v", result.Status)
		}
	}
}

func TestOneBytePullsForOneWord(t *testing.T) {
	const wordLen = 32
	codes := []uint16{256, 65}
	for code := 258; code <= 256+wordLen; code++ {
		codes = append(codes, uint16(code))
	}
	codes = append(codes, 257)

	stream := mustRefPack(t, codes, 0)
	ref := mustRefDecode(t, stream, 0)
	dec := newTestDecoder(t, 0, 1<<20, stream)

	var output []byte
	var sawTarget bool
	firstOffset := uint64(0)
	firstWidth := uint8(0)
	nextWordOffset := 0
	targetCode := 256 + wordLen

	for {
		result := dec.Pull(1)
		output = append(output, result.Data...)
		if len(result.Data) > 1 {
			t.Fatalf("Pull(1) returned %d bytes", len(result.Data))
		}
		for _, segment := range result.Segments {
			if segment.Source.Code == targetCode {
				if !sawTarget {
					sawTarget = true
					firstOffset = segment.Source.BitOffset
					firstWidth = segment.Source.BitWidth
					if segment.Source.WordLength != wordLen {
						t.Fatalf("target word length=%d", segment.Source.WordLength)
					}
				}
				if segment.Source.BitOffset != firstOffset || segment.Source.BitWidth != firstWidth ||
					segment.Source.WordLength != wordLen {
					t.Fatalf("target source changed: %+v", segment.Source)
				}
				if segment.Source.WordOffset != nextWordOffset {
					t.Fatalf("target word offset=%d want %d", segment.Source.WordOffset, nextWordOffset)
				}
				nextWordOffset++
			}
		}
		switch result.Status {
		case dataeng.StatusEnd:
			if !bytes.Equal(output, ref.Output) {
				t.Fatalf("1-byte Pull output mismatch: got %d want %d", len(output), len(ref.Output))
			}
			if !sawTarget || nextWordOffset != wordLen {
				t.Fatalf("target word was not fully delivered: saw=%t offsets=%d", sawTarget, nextWordOffset)
			}
			return
		case dataeng.StatusNeedOutput:
			continue
		case dataeng.StatusFailed:
			t.Fatalf("failed: %v", result.Err)
		default:
			t.Fatalf("unexpected status %v", result.Status)
		}
	}
}

func TestZeroCapacity(t *testing.T) {
	codes := []uint16{256, 65, 66, 257}
	stream := mustRefPack(t, codes, 0)

	dec, err := dataeng.NewDecoder(0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := dec.Feed(stream); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 3; i++ {
		result := dec.Pull(0)
		if len(result.Data) != 0 || result.Status == dataeng.StatusEnd || result.Err != nil {
			t.Fatalf("Pull(0) made progress: %+v", result)
		}
	}

	if err := dec.Finish(); err != nil {
		t.Fatal(err)
	}
	output, _ := pullUntilDone(t, dec, 10)
	if string(output) != "AB" {
		t.Fatalf("output=%q", output)
	}

	// Pull(0) must not turn a valid but not-yet-decoded stream into END, and
	// must not consume an invalid ordinary code before capacity is supplied.
	invalid := packFixedWidth([]uint16{256, 259}, 9)
	dec = newTestDecoder(t, 0, 100, invalid)
	result := dec.Pull(0)
	if result.Status == dataeng.StatusFailed || result.Err != nil {
		t.Fatalf("Pull(0) consumed invalid ordinary code: %+v", result)
	}
	result = dec.Pull(10)
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrInvalidCode) {
		t.Fatalf("invalid code status=%v err=%v", result.Status, result.Err)
	}

	// Zero capacity in the middle of a word.
	stream = mustRefPack(t, []uint16{256, 65, 258, 257}, 0)
	dec = newTestDecoder(t, 0, 100, stream)
	if got := dec.Pull(1); string(got.Data) != "A" {
		t.Fatalf("first byte = %q", got.Data)
	}
	got := dec.Pull(1)
	if string(got.Data) != "A" || got.Status != dataeng.StatusNeedOutput {
		t.Fatalf("first half of AA: %+v", got)
	}
	got = dec.Pull(0)
	if len(got.Data) != 0 || got.Status != dataeng.StatusNeedOutput {
		t.Fatalf("Pull(0) with pending suffix: %+v", got)
	}
	got = dec.Pull(1)
	if string(got.Data) != "A" {
		t.Fatalf("second half of AA: %+v", got)
	}
	got = dec.Pull(1)
	if got.Status != dataeng.StatusEnd {
		t.Fatalf("final status = %v", got.Status)
	}
}

func TestOutputLimit(t *testing.T) {
	stream := mustRefPack(t, []uint16{256, 65, 66, 257}, 0)

	exact := newTestDecoder(t, 0, 2, stream)
	output, results := pullUntilDone(t, exact, 100)
	if string(output) != "AB" || results[len(results)-1].Status != dataeng.StatusEnd {
		t.Fatalf("exact limit output=%q status=%v", output, results[len(results)-1].Status)
	}

	short := newTestDecoder(t, 0, 1, stream)
	result := short.Pull(100)
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrOutputLimit) {
		t.Fatalf("limit-1 status=%v err=%v", result.Status, result.Err)
	}
	if string(result.Data) != "A" {
		t.Fatalf("limit-1 delivered %q, want prefix A", result.Data)
	}

	zero := newTestDecoder(t, 0, 0, stream)
	result = zero.Pull(100)
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrOutputLimit) || len(result.Data) != 0 {
		t.Fatalf("limit-0 result=%+v", result)
	}

	// +65, +258("AA"), +259("AAA"), +260("AAAA") has total length 10.
	longCodes := []uint16{256, 65, 258, 259, 260, 257}
	longStream := mustRefPack(t, longCodes, 0)
	limit9 := newTestDecoder(t, 0, 9, longStream)
	result = limit9.Pull(100)
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrOutputLimit) {
		t.Fatalf("limit-9 status=%v err=%v", result.Status, result.Err)
	}
	if string(result.Data) != "AAAAAA" {
		t.Fatalf("limit-9 must fail before the 4-byte word, got %q", result.Data)
	}

	limit10 := newTestDecoder(t, 0, 10, longStream)
	output, results = pullUntilDone(t, limit10, 100)
	if len(output) != 10 || results[len(results)-1].Status != dataeng.StatusEnd {
		t.Fatalf("limit-10 output=%q status=%v", output, results[len(results)-1].Status)
	}

	unbounded := newTestDecoder(t, 0, math.MaxUint64, stream)
	output, _ = pullUntilDone(t, unbounded, 100)
	if string(output) != "AB" {
		t.Fatalf("MaxUint64 output=%q", output)
	}

	empty := newTestDecoder(t, 0, 0, mustRefPack(t, []uint16{256, 257}, 0))
	output, results = pullUntilDone(t, empty, 10)
	if len(output) != 0 || results[len(results)-1].Status != dataeng.StatusEnd {
		t.Fatalf("zero limit on empty output: output=%q status=%v", output, results[len(results)-1].Status)
	}
}

func TestFinishDrainsPendingSuffix(t *testing.T) {
	stream := mustRefPack(t, []uint16{256, 65, 258, 257}, 0)
	dec, err := dataeng.NewDecoder(0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := dec.Feed(stream); err != nil {
		t.Fatal(err)
	}

	result := dec.Pull(2)
	if string(result.Data) != "AA" || result.Status != dataeng.StatusNeedOutput {
		t.Fatalf("initial pull=%+v", result)
	}
	if err := dec.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	var output []byte
	output = append(output, result.Data...)
	for {
		result = dec.Pull(1)
		output = append(output, result.Data...)
		if result.Status == dataeng.StatusEnd {
			break
		}
		if result.Status != dataeng.StatusNeedOutput {
			t.Fatalf("status after Finish=%v err=%v", result.Status, result.Err)
		}
	}
	if string(output) != "AAA" {
		t.Fatalf("output=%q", output)
	}
}

func TestFinishDrainsThenReportsMissingEnd(t *testing.T) {
	stream := mustRefPack(t, []uint16{256, 65, 258}, 0)
	dec, err := dataeng.NewDecoder(0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := dec.Feed(stream); err != nil {
		t.Fatal(err)
	}
	result := dec.Pull(2)
	if string(result.Data) != "AA" || result.Status != dataeng.StatusNeedOutput {
		t.Fatalf("initial pull=%+v", result)
	}
	if err := dec.Finish(); err != nil {
		t.Fatal(err)
	}

	var output []byte
	output = append(output, result.Data...)
	for {
		result = dec.Pull(1)
		output = append(output, result.Data...)
		if result.Status == dataeng.StatusFailed {
			if !errors.Is(result.Err, dataeng.ErrTruncatedCode) {
				t.Fatalf("err=%v", result.Err)
			}
			break
		}
		if result.Status != dataeng.StatusNeedOutput {
			t.Fatalf("status=%v", result.Status)
		}
	}
	if string(output) != "AAA" {
		t.Fatalf("output=%q", output)
	}
}

func TestMalformedStreams(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		dec := newTestDecoder(t, 0, 100, nil)
		result := dec.Pull(100)
		if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrMissingEnd) {
			t.Fatalf("status=%v err=%v", result.Status, result.Err)
		}
	})

	t.Run("first-not-clear", func(t *testing.T) {
		stream := packFixedWidth([]uint16{65, 257}, 9)
		dec := newTestDecoder(t, 0, 100, stream)
		result := dec.Pull(100)
		if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrMissingClear) {
			t.Fatalf("status=%v err=%v", result.Status, result.Err)
		}
	})

	t.Run("missing-end-after-output", func(t *testing.T) {
		// Eight 9-bit codes occupy exactly nine bytes, leaving no partial code.
		stream := mustRefPack(t, []uint16{256, 65, 65, 65, 65, 65, 65, 65}, 0)
		dec := newTestDecoder(t, 0, 100, stream)
		result := dec.Pull(100)
		if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrMissingEnd) {
			t.Fatalf("status=%v err=%v", result.Status, result.Err)
		}
		if string(result.Data) != "AAAAAAA" {
			t.Fatalf("prefix=%q", result.Data)
		}
	})

	t.Run("partial-code", func(t *testing.T) {
		stream := mustRefPack(t, []uint16{256}, 0)
		// Append four more bits of a next code. Nine CLEAR bits plus four
		// bits occupy two physical bytes; the remaining seven bits are less
		// than a 9-bit code.
		writer := refBitWriter{}
		writer.write(257, 4)
		stream = append(stream, writer.finish()...)
		dec := newTestDecoder(t, 0, 100, stream)
		result := dec.Pull(100)
		if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrTruncatedCode) {
			t.Fatalf("status=%v err=%v", result.Status, result.Err)
		}
	})

	t.Run("non-zero-padding", func(t *testing.T) {
		stream := mustRefPack(t, []uint16{256, 257}, 0)
		stream[len(stream)-1] |= 1
		dec := newTestDecoder(t, 0, 100, stream)
		result := dec.Pull(100)
		if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrNonZeroPadding) {
			t.Fatalf("status=%v err=%v", result.Status, result.Err)
		}
	})

	t.Run("trailing-byte", func(t *testing.T) {
		stream := mustRefPack(t, []uint16{256, 257}, 0)
		stream = append(stream, 0)
		dec := newTestDecoder(t, 0, 100, stream)
		result := dec.Pull(100)
		if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrTrailingData) {
			t.Fatalf("status=%v err=%v", result.Status, result.Err)
		}
	})

	t.Run("trailing-byte-fed-after-end", func(t *testing.T) {
		stream := mustRefPack(t, []uint16{256, 257}, 0)
		dec, err := dataeng.NewDecoder(0, 100)
		if err != nil {
			t.Fatal(err)
		}
		if err := dec.Feed(stream); err != nil {
			t.Fatal(err)
		}
		result := dec.Pull(100)
		if result.Status != dataeng.StatusNeedFinish {
			t.Fatalf("before extra Feed status=%v", result.Status)
		}
		if err := dec.Feed([]byte{0}); !errors.Is(err, dataeng.ErrTrailingData) {
			t.Fatalf("Feed after END err=%v", err)
		}
		result = dec.Pull(100)
		if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrTrailingData) {
			t.Fatalf("status=%v err=%v", result.Status, result.Err)
		}
	})
}

func TestEndNotReportedBeforeFinish(t *testing.T) {
	stream := mustRefPack(t, []uint16{256, 257}, 0)
	dec, err := dataeng.NewDecoder(0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := dec.Feed(stream); err != nil {
		t.Fatal(err)
	}

	result := dec.Pull(100)
	if result.Status != dataeng.StatusNeedFinish {
		t.Fatalf("before Finish status=%v", result.Status)
	}
	if len(result.Data) != 0 {
		t.Fatalf("empty-output END produced %q", result.Data)
	}
	if err := dec.Finish(); err != nil {
		t.Fatal(err)
	}
	result = dec.Pull(100)
	if result.Status != dataeng.StatusEnd {
		t.Fatalf("after Finish status=%v err=%v", result.Status, result.Err)
	}
}

func TestZeroCapacityTerminalStates(t *testing.T) {
	stream := mustRefPack(t, []uint16{256, 257}, 0)
	dec, err := dataeng.NewDecoder(0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := dec.Feed(stream); err != nil {
		t.Fatal(err)
	}

	result := dec.Pull(0)
	if result.Status != dataeng.StatusNeedOutput || len(result.Data) != 0 {
		t.Fatalf("Pull(0) before decoding END=%+v", result)
	}
	result = dec.Pull(1)
	if result.Status != dataeng.StatusNeedFinish {
		t.Fatalf("after END status=%v", result.Status)
	}
	result = dec.Pull(0)
	if result.Status != dataeng.StatusNeedFinish {
		t.Fatalf("Pull(0) after END before Finish=%v", result.Status)
	}
	if err := dec.Finish(); err != nil {
		t.Fatal(err)
	}
	result = dec.Pull(0)
	if result.Status != dataeng.StatusEnd || len(result.Data) != 0 {
		t.Fatalf("Pull(0) after Finish=%+v", result)
	}
}

func TestRepeatedClear(t *testing.T) {
	codes := []uint16{256, 256, 65, 256, 66, 257}
	for _, early := range []int{0, 1} {
		stream := mustRefPack(t, codes, early)
		ref := mustRefDecode(t, stream, early)
		dec := newTestDecoder(t, early, 100, stream)
		output, _ := pullUntilDone(t, dec, 10)
		if !bytes.Equal(output, ref.Output) || string(output) != "AB" {
			t.Fatalf("early=%d repeated clear output=%q want AB", early, output)
		}
	}
}

func TestInvalidEarlyChange(t *testing.T) {
	if _, err := dataeng.NewDecoder(2, 100); !errors.Is(err, dataeng.ErrInvalidEarlyChange) {
		t.Fatalf("NewDecoder(2) err=%v", err)
	}
	if _, err := dataeng.NewDecoder(-1, 100); !errors.Is(err, dataeng.ErrInvalidEarlyChange) {
		t.Fatalf("NewDecoder(-1) err=%v", err)
	}
}

func TestHostContractErrors(t *testing.T) {
	dec, err := dataeng.NewDecoder(0, 100)
	if err != nil {
		t.Fatal(err)
	}
	result := dec.Pull(-1)
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrInvalidMaxBytes) {
		t.Fatalf("negative maxBytes: status=%v err=%v", result.Status, result.Err)
	}
	if err := dec.Feed([]byte{1}); !errors.Is(err, dataeng.ErrInvalidMaxBytes) {
		t.Fatalf("Feed on failed decoder err=%v", err)
	}
	if !errors.Is(dec.Err(), dataeng.ErrInvalidMaxBytes) {
		t.Fatalf("Err()=%v", dec.Err())
	}

	stream := mustRefPack(t, []uint16{256, 257}, 0)
	dec, err = dataeng.NewDecoder(0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := dec.Feed(stream); err != nil {
		t.Fatal(err)
	}
	if err := dec.Finish(); err != nil {
		t.Fatal(err)
	}
	if err := dec.Feed([]byte{0}); !errors.Is(err, dataeng.ErrFeedAfterFinish) {
		t.Fatalf("Feed after Finish err=%v", err)
	}
	if dec.Err() != nil {
		t.Fatalf("Feed-after-Finish unexpectedly failed the stream: %v", dec.Err())
	}
	result = dec.Pull(10)
	if result.Status != dataeng.StatusEnd {
		t.Fatalf("sealed stream status=%v", result.Status)
	}
}
