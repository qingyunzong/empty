package q154

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"math"
	"math/bits"
	"math/rand"
	"testing"
)

// bitWriter is an independent, straightforwardly implemented MSB-first bit
// sink used only by the tests to produce frames for the production decoder.
type bitWriter struct {
	buf   []byte
	cache byte
	bits  uint
}

func (w *bitWriter) writeBits(value uint64, n uint) {
	for n > 0 {
		take := 8 - w.bits
		if take > n {
			take = n
		}
		shift := n - take
		w.cache = w.cache<<take | byte((value>>shift)&((1<<take)-1))
		w.bits += take
		n -= take
		if w.bits == 8 {
			w.buf = append(w.buf, w.cache)
			w.cache = 0
			w.bits = 0
		}
	}
}

func (w *bitWriter) writeByte(b byte) {
	w.writeBits(uint64(b), 8)
}

func (w *bitWriter) writeSLEB128(v int64) {
	for {
		b := byte(v & 0x7f)
		signBitSet := b&0x40 != 0
		v >>= 7
		if (v == 0 && !signBitSet) || (v == -1 && signBitSet) {
			w.writeByte(b)
			return
		}
		w.writeByte(b | 0x80)
	}
}

func (w *bitWriter) padToByte() {
	if w.bits > 0 {
		w.writeBits(0, 8-w.bits)
	}
}

// encodeFrame builds one frame independently of the decoder implementation.
func encodeFrame(records []Record) []byte {
	var body bitWriter
	body.writeBits(uint64(len(records)), 32)

	var (
		prevTS    int64
		delta     int64
		prevValue uint64
	)
	for i, rec := range records {
		if i == 0 {
			body.writeBits(uint64(rec.Timestamp), 64)
			body.writeBits(rec.Value, 64)
			prevTS = rec.Timestamp
			prevValue = rec.Value
			continue
		}

		nextDelta := rec.Timestamp - prevTS
		dod := nextDelta - delta
		if dod == 0 {
			body.writeBits(0, 1)
		} else {
			body.writeBits(1, 1)
			body.writeSLEB128(dod)
		}
		delta = nextDelta
		prevTS = rec.Timestamp

		xor := rec.Value ^ prevValue
		if xor == 0 {
			body.writeBits(0, 1)
		} else {
			body.writeBits(1, 1)
			leading := uint(bits.LeadingZeros64(xor))
			trailing := uint(bits.TrailingZeros64(xor))
			width := 64 - leading - trailing
			if width > 63 {
				leading = 0
				width = 64
			}
			widthField := width
			if width == 64 {
				widthField = 0
			}
			body.writeBits(uint64(leading), 6)
			body.writeBits(uint64(widthField), 6)
			significant := (xor << leading) >> (64 - width)
			body.writeBits(significant, width)
		}
		prevValue = rec.Value
	}

	body.padToByte()
	out := make([]byte, len(body.buf)+4)
	copy(out, body.buf)
	binary.BigEndian.PutUint32(out[len(body.buf):], crc32.ChecksumIEEE(body.buf))
	return out
}

// chunkReader serves data in randomized, deliberately small block sizes to
// prove bit state survives arbitrary transport boundaries.
type chunkReader struct {
	data []byte
	rng  *rand.Rand
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if len(c.data) == 0 {
		return 0, io.EOF
	}
	n := c.rng.Intn(3) + 1
	if n > len(c.data) {
		n = len(c.data)
	}
	if n > len(p) {
		n = len(p)
	}
	n = copy(p, c.data[:n])
	c.data = c.data[n:]
	return n, nil
}

func decodeAll(t *testing.T, r io.Reader) [][]Record {
	t.Helper()
	d := NewDecoder(r)
	var frames [][]Record
	for {
		var got []Record
		err := d.DecodeFrame(func(rec Record) error {
			got = append(got, rec)
			return nil
		})
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("unexpected decode error: %v", err)
		}
		frames = append(frames, got)
	}
	return frames
}

func finishFrame(w *bitWriter) []byte {
	w.padToByte()
	out := make([]byte, len(w.buf)+4)
	copy(out, w.buf)
	binary.BigEndian.PutUint32(out[len(w.buf):], crc32.ChecksumIEEE(w.buf))
	return out
}

func expectDecodeError(t *testing.T, frame []byte, want error) {
	t.Helper()
	d := NewDecoder(bytes.NewReader(frame))
	delivered := 0
	err := d.DecodeFrame(func(Record) error {
		delivered++
		return nil
	})
	if !errors.Is(err, want) {
		t.Fatalf("got %v want %v", err, want)
	}
	if delivered != 0 {
		t.Fatalf("delivered %d records on invalid frame", delivered)
	}
}

func TestRoundTripChunked(t *testing.T) {
	rng := rand.New(rand.NewSource(154))
	var stream []byte
	var want [][]Record

	for frame := 0; frame < 40; frame++ {
		n := rng.Intn(200)
		recs := make([]Record, n)
		ts := rng.Int63n(1_000_000) - 500_000
		step := rng.Int63n(50) + 1
		var value uint64 = rng.Uint64()
		for i := range recs {
			recs[i] = Record{Timestamp: ts, Value: value}
			if rng.Intn(4) != 0 {
				step += rng.Int63n(7)
			}
			if rng.Intn(3) == 0 {
				value = rng.Uint64()
			}
			ts += step
		}
		want = append(want, recs)
		stream = append(stream, encodeFrame(recs)...)
	}

	got := decodeAll(t, &chunkReader{data: stream, rng: rng})
	if len(got) != len(want) {
		t.Fatalf("frame count: got %d want %d", len(got), len(want))
	}
	for i := range want {
		if len(got[i]) != len(want[i]) {
			t.Fatalf("frame %d record count: got %d want %d", i, len(got[i]), len(want[i]))
		}
		for j := range want[i] {
			if got[i][j] != want[i][j] {
				t.Fatalf("frame %d record %d: got %+v want %+v", i, j, got[i][j], want[i][j])
			}
		}
	}
}

func TestNaNBitPatterns(t *testing.T) {
	values := []uint64{
		math.Float64bits(math.NaN()),
		math.Float64bits(math.Inf(1)),
		math.Float64bits(math.Inf(-1)),
		0x7ff8000000000001,
		0x7ff0000000000001,
		0xffffffffffffffff,
		0x0000000000000001,
	}
	recs := make([]Record, len(values))
	for i, v := range values {
		recs[i] = Record{Timestamp: int64(i) * 17, Value: v}
	}
	got := decodeAll(t, bytes.NewReader(encodeFrame(recs)))
	if len(got) != 1 || len(got[0]) != len(recs) {
		t.Fatalf("unexpected records: %+v", got)
	}
	for i := range recs {
		if got[0][i].Value != recs[i].Value {
			t.Fatalf("record %d bit pattern: got %016x want %016x", i, got[0][i].Value, recs[i].Value)
		}
	}
}

func TestZeroRecordFrame(t *testing.T) {
	frame := encodeFrame(nil)
	if len(frame) != 8 {
		t.Fatalf("zero-record frame size: got %d want 8", len(frame))
	}
	got := decodeAll(t, bytes.NewReader(frame))
	if len(got) != 1 || len(got[0]) != 0 {
		t.Fatalf("expected one empty frame, got %+v", got)
	}
}

func TestEmptyReaderIsCleanEOF(t *testing.T) {
	d := NewDecoder(bytes.NewReader(nil))
	if err := d.DecodeFrame(nil); !errors.Is(err, io.EOF) {
		t.Fatalf("got %v want io.EOF", err)
	}
}

func TestTruncationNeverDelivers(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	recs := make([]Record, 25)
	for i := range recs {
		recs[i] = Record{Timestamp: int64(i) * 11, Value: rng.Uint64()}
	}
	full := encodeFrame(recs)

	for cut := 0; cut < len(full); cut++ {
		d := NewDecoder(bytes.NewReader(append([]byte(nil), full[:cut]...)))
		delivered := 0
		err := d.DecodeFrame(func(Record) error {
			delivered++
			return nil
		})
		if delivered != 0 {
			t.Fatalf("cut %d delivered %d records before validation", cut, delivered)
		}
		if cut == 0 {
			if !errors.Is(err, io.EOF) {
				t.Fatalf("cut %d: got %v want io.EOF", cut, err)
			}
			continue
		}
		if !errors.Is(err, ErrTruncated) {
			t.Fatalf("cut %d: got %v want ErrTruncated", cut, err)
		}
	}
}

func TestCRCMismatch(t *testing.T) {
	recs := []Record{{Timestamp: 1, Value: 42}}
	frame := encodeFrame(recs)
	frame[len(frame)-1] ^= 0x01
	d := NewDecoder(bytes.NewReader(frame))
	delivered := 0
	err := d.DecodeFrame(func(Record) error {
		delivered++
		return nil
	})
	if !errors.Is(err, ErrCRC) || delivered != 0 {
		t.Fatalf("got err=%v delivered=%d", err, delivered)
	}
}

func TestNonCanonicalLEB128(t *testing.T) {
	cases := [][]byte{
		{0x80, 0x00},
		{0xff, 0x7f},
		{0x80, 0x80, 0x00},
		{0xff, 0xff, 0x7f},
	}
	for _, leb := range cases {
		var w bitWriter
		w.writeBits(2, 32)
		w.writeBits(100, 64)
		w.writeBits(1, 64)
		w.writeBits(1, 1)
		for _, b := range leb {
			w.writeByte(b)
		}
		w.writeBits(0, 1)
		expectDecodeError(t, finishFrame(&w), ErrLEB128)
	}
}

func TestLEB128Overflow(t *testing.T) {
	cases := [][]byte{
		{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7e},
		{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02},
		{0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00},
	}
	for _, leb := range cases {
		var w bitWriter
		w.writeBits(2, 32)
		w.writeBits(0, 64)
		w.writeBits(0, 64)
		w.writeBits(1, 1)
		for _, b := range leb {
			w.writeByte(b)
		}
		w.writeBits(0, 1)
		expectDecodeError(t, finishFrame(&w), ErrLEB128)
	}
}

func TestSLEB128ExtremesRoundTrip(t *testing.T) {
	for _, dod := range []int64{math.MinInt64, math.MaxInt64, -1, 1, 63, 64, -64, -65} {
		recs := []Record{
			{Timestamp: 0, Value: 1},
			{Timestamp: dod, Value: 1},
		}
		got := decodeAll(t, bytes.NewReader(encodeFrame(recs)))
		if got[0][1].Timestamp != dod {
			t.Fatalf("dod %d round trip: got %d", dod, got[0][1].Timestamp)
		}
	}
}

func TestElevenByteLEB128Rejected(t *testing.T) {
	leb := make([]byte, 11)
	for i := range leb[:10] {
		leb[i] = 0x80
	}
	leb[10] = 0x00

	var w bitWriter
	w.writeBits(2, 32)
	w.writeBits(0, 64)
	w.writeBits(0, 64)
	w.writeBits(1, 1)
	for _, b := range leb {
		w.writeByte(b)
	}
	w.writeBits(0, 1)
	expectDecodeError(t, finishFrame(&w), ErrLEB128)
}

func TestSingleByteChunksRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for iter := 0; iter < 50; iter++ {
		n := rng.Intn(64) + 1
		recs := make([]Record, n)
		ts := int64(iter)
		var step int64 = 1
		for i := range recs {
			recs[i] = Record{Timestamp: ts, Value: rng.Uint64()}
			step += rng.Int63n(4)
			ts += step
		}
		frame := encodeFrame(recs)
		got := decodeAll(t, &oneByteReader{data: frame})
		if len(got) != 1 || len(got[0]) != n {
			t.Fatalf("iter %d: unexpected frame shape %+v", iter, got)
		}
		for j := range recs {
			if got[0][j] != recs[j] {
				t.Fatalf("iter %d record %d: got %+v want %+v", iter, j, got[0][j], recs[j])
			}
		}
	}
}

type oneByteReader struct {
	data []byte
}

func (r *oneByteReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	if len(p) == 0 {
		return 0, nil
	}
	p[0] = r.data[0]
	r.data = r.data[1:]
	return 1, nil
}

func TestOutOfRangeWidth(t *testing.T) {
	var w bitWriter
	w.writeBits(2, 32)
	w.writeBits(0, 64)
	w.writeBits(0, 64)
	w.writeBits(0, 1)
	w.writeBits(1, 1)
	w.writeBits(60, 6)
	w.writeBits(10, 6)
	w.writeBits(0, 1)
	expectDecodeError(t, finishFrame(&w), ErrWidth)
}

func TestWidthZeroMeans64(t *testing.T) {
	recs := []Record{
		{Timestamp: 0, Value: 0},
		{Timestamp: 5, Value: 1},
	}
	got := decodeAll(t, bytes.NewReader(encodeFrame(recs)))
	if got[0][1].Value != 1 {
		t.Fatalf("got value %d want 1", got[0][1].Value)
	}
}

func TestTimestampOverflow(t *testing.T) {
	var w bitWriter
	w.writeBits(2, 32)
	w.writeBits(uint64(math.MaxInt64), 64)
	w.writeBits(0, 64)
	w.writeBits(1, 1)
	w.writeSLEB128(1)
	w.writeBits(0, 1)
	expectDecodeError(t, finishFrame(&w), ErrOverflow)
}

func TestNonZeroPadding(t *testing.T) {
	var w bitWriter
	w.writeBits(2, 32)
	w.writeBits(0, 64)
	w.writeBits(0, 64)
	w.writeBits(0, 1)
	w.writeBits(0, 1)
	w.buf = append(w.buf, w.cache|0x01)
	w.cache = 0
	w.bits = 0
	expectDecodeError(t, finishFrame(&w), ErrPadding)
}

func TestDeclaredCountExceedsData(t *testing.T) {
	var w bitWriter
	w.writeBits(100, 32)
	w.writeBits(1, 64)
	w.writeBits(1, 64)
	frame := finishFrame(&w)
	expectDecodeError(t, frame, ErrTruncated)
}

func TestMultipleFramesAndChunkedCRC(t *testing.T) {
	first := encodeFrame([]Record{{Timestamp: 1, Value: 9}})
	second := encodeFrame([]Record{{Timestamp: 2, Value: 10}, {Timestamp: 4, Value: 11}})
	stream := append(first, second...)
	got := decodeAll(t, &chunkReader{data: stream, rng: rand.New(rand.NewSource(11))})
	if len(got) != 2 {
		t.Fatalf("frame count: got %d want 2", len(got))
	}
	if got[0][0].Value != 9 || got[1][1].Timestamp != 4 {
		t.Fatalf("unexpected frames: %+v", got)
	}
}

func FuzzDecoderNeverPanics(f *testing.F) {
	f.Add([]byte{0, 0, 0, 0, 0, 0, 0, 0})
	f.Fuzz(func(t *testing.T, data []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("decoder panicked: %v", r)
			}
		}()
		d := NewDecoder(bytes.NewReader(data))
		for {
			err := d.DecodeFrame(nil)
			if err != nil {
				return
			}
		}
	})
}

func FuzzRoundTripChunked(f *testing.F) {
	f.Add(int64(42), uint64(7), int64(3))
	f.Fuzz(func(t *testing.T, baseTS int64, baseValue uint64, seed int64) {
		rng := rand.New(rand.NewSource(seed))
		n := int(rng.Int63n(40)) + 1
		recs := make([]Record, n)
		ts := baseTS % (1 << 40)
		var step int64 = 1
		for i := range recs {
			recs[i] = Record{Timestamp: ts, Value: baseValue + uint64(i)*rng.Uint64()}
			step += rng.Int63n(3)
			ts += step
		}

		frame := encodeFrame(recs)
		chunkSize := int(rng.Int63n(3)) + 1
		d := NewDecoder(&fixedChunkReader{data: frame, size: chunkSize})
		var got []Record
		err := d.DecodeFrame(func(r Record) error {
			got = append(got, r)
			return nil
		})
		if err != nil {
			t.Fatalf("decode failed: %v", err)
		}
		if len(got) != len(recs) {
			t.Fatalf("record count: got %d want %d", len(got), len(recs))
		}
		for i := range recs {
			if got[i] != recs[i] {
				t.Fatalf("record %d: got %+v want %+v", i, got[i], recs[i])
			}
		}
	})
}

type fixedChunkReader struct {
	data []byte
	size int
}

func (r *fixedChunkReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := r.size
	if n > len(r.data) {
		n = len(r.data)
	}
	if n > len(p) {
		n = len(p)
	}
	n = copy(p, r.data[:n])
	r.data = r.data[n:]
	return n, nil
}
