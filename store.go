package dedup

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"sort"
)

const (
	recDelta    = 1
	recSnapshot = 2

	headerLen     = 8 // uint32 payload length + uint32 payload CRC32
	maxRecordLen  = 1 << 28
	maxWindowSize = 1 << 24
)

var errCorrupt = errors.New("dedup: corrupt record")

// Store persists dedup windows and effects in a single append-only log
// on a Volume. Each Commit writes one record containing both the
// producer's dedup window and the message's effect, so dedup state and
// effects become durable in the same atomic batch. Recovery scans the
// log up to the first missing, truncated or corrupt record and ignores
// the (uncommitted) tail.
type Store struct {
	v          Volume
	windowSize int

	// Windows holds the recovered/committed dedup window per producer.
	Windows map[string]Window
	// Journal holds the committed effects in commit order.
	Journal [][]byte

	validLen  int64
	needsTrim bool
}

// OpenStore recovers a Store from v. windowSize is the dedup window
// size (slots below the high-water mark) and must match the size used
// when the log was written.
func OpenStore(v Volume, windowSize int) (*Store, error) {
	if windowSize <= 0 {
		return nil, fmt.Errorf("dedup: window size must be positive, got %d", windowSize)
	}
	data, err := v.ReadAll()
	if err != nil {
		return nil, err
	}
	s := &Store{
		v:          v,
		windowSize: windowSize,
		Windows:    make(map[string]Window),
	}
	off := 0
	for off < len(data) {
		if len(data)-off < headerLen {
			break // torn header
		}
		n := binary.BigEndian.Uint32(data[off:])
		if n == 0 || n > maxRecordLen || len(data)-off-headerLen < int(n) {
			break // torn or absurd record
		}
		payload := data[off+headerLen : off+headerLen+int(n)]
		if crc32.ChecksumIEEE(payload) != binary.BigEndian.Uint32(data[off+4:]) {
			break // torn or corrupt tail: not committed
		}
		if err := s.apply(payload); err != nil {
			return nil, err
		}
		off += headerLen + int(n)
	}
	s.validLen = int64(off)
	s.needsTrim = off < len(data)
	return s, nil
}

// WindowSize returns the dedup window size the store was opened with.
func (s *Store) WindowSize() int { return s.windowSize }

// Commit atomically persists the producer's dedup window together with
// the message's effect. On success both are durable; on failure neither
// is, and the message should be redelivered.
func (s *Store) Commit(producer string, w Window, effect []byte) error {
	if len(producer) > 0xffff {
		return fmt.Errorf("dedup: producer id too long: %d bytes", len(producer))
	}
	if err := s.checkWindow(w); err != nil {
		return err
	}
	rec := encodeRecord(encodeDelta(producer, w, effect))
	if err := s.append(rec); err != nil {
		return err
	}
	s.Windows[producer] = w
	s.Journal = append(s.Journal, effect)
	return nil
}

// Compact rewrites the log as a single snapshot record containing all
// dedup windows and the effect journal. The replacement is atomic with
// respect to crashes.
func (s *Store) Compact() error {
	rec := encodeRecord(encodeSnapshot(s.Windows, s.Journal))
	if err := s.v.Replace(rec); err != nil {
		return err
	}
	if err := s.v.Sync(); err != nil {
		return err
	}
	s.validLen = int64(len(rec))
	s.needsTrim = false
	return nil
}

// append stages the record after any uncommitted tail and syncs.
func (s *Store) append(rec []byte) error {
	if s.needsTrim {
		if err := s.v.Truncate(s.validLen); err != nil {
			return err
		}
		s.needsTrim = false
	}
	if err := s.v.Append(rec); err != nil {
		return err
	}
	if err := s.v.Sync(); err != nil {
		return err
	}
	s.validLen += int64(len(rec))
	return nil
}

func (s *Store) checkWindow(w Window) error {
	if w.Size != s.windowSize {
		return fmt.Errorf("dedup: window size %d does not match store size %d", w.Size, s.windowSize)
	}
	return nil
}

func (s *Store) apply(payload []byte) error {
	d := &decoder{buf: payload}
	switch d.u8() {
	case recDelta:
		producer := d.string16()
		w := d.window()
		effect := d.bytes32()
		if d.err != nil {
			return d.err
		}
		if err := s.checkWindow(w); err != nil {
			return err
		}
		s.Windows[producer] = w
		s.Journal = append(s.Journal, effect)
	case recSnapshot:
		n := d.u32()
		windows := make(map[string]Window)
		for i := uint32(0); i < n; i++ {
			producer := d.string16()
			w := d.window()
			if d.err != nil {
				return d.err
			}
			windows[producer] = w
		}
		nj := d.u32()
		var journal [][]byte
		for i := uint32(0); i < nj; i++ {
			effect := d.bytes32()
			if d.err != nil {
				return d.err
			}
			journal = append(journal, effect)
		}
		if d.err != nil {
			return d.err
		}
		for _, w := range windows {
			if err := s.checkWindow(w); err != nil {
				return err
			}
		}
		s.Windows = windows
		s.Journal = journal
	default:
		return fmt.Errorf("dedup: unknown record kind %d", payload[0])
	}
	if d.err != nil {
		return d.err
	}
	if d.off != len(d.buf) {
		return errCorrupt
	}
	return nil
}

func encodeRecord(payload []byte) []byte {
	rec := make([]byte, 0, headerLen+len(payload))
	rec = binary.BigEndian.AppendUint32(rec, uint32(len(payload)))
	rec = binary.BigEndian.AppendUint32(rec, crc32.ChecksumIEEE(payload))
	return append(rec, payload...)
}

func encodeDelta(producer string, w Window, effect []byte) []byte {
	buf := []byte{recDelta}
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(producer)))
	buf = append(buf, producer...)
	buf = w.appendTo(buf)
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(effect)))
	return append(buf, effect...)
}

func encodeSnapshot(windows map[string]Window, journal [][]byte) []byte {
	producers := make([]string, 0, len(windows))
	for p := range windows {
		producers = append(producers, p)
	}
	sort.Strings(producers)
	buf := []byte{recSnapshot}
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(producers)))
	for _, p := range producers {
		buf = binary.BigEndian.AppendUint16(buf, uint16(len(p)))
		buf = append(buf, p...)
		buf = windows[p].appendTo(buf)
	}
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(journal)))
	for _, effect := range journal {
		buf = binary.BigEndian.AppendUint32(buf, uint32(len(effect)))
		buf = append(buf, effect...)
	}
	return buf
}

// decoder is a bounds-checked cursor over a record payload.
type decoder struct {
	buf []byte
	off int
	err error
}

func (d *decoder) take(n int) []byte {
	if d.err != nil {
		return nil
	}
	if n < 0 || len(d.buf)-d.off < n {
		d.err = errCorrupt
		return nil
	}
	b := d.buf[d.off : d.off+n]
	d.off += n
	return b
}

func (d *decoder) u8() uint8 {
	b := d.take(1)
	if b == nil {
		return 0
	}
	return b[0]
}

func (d *decoder) u16() uint16 {
	b := d.take(2)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint16(b)
}

func (d *decoder) u32() uint32 {
	b := d.take(4)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint32(b)
}

func (d *decoder) u64() uint64 {
	b := d.take(8)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint64(b)
}

func (d *decoder) string16() string {
	n := d.u16()
	if d.err != nil {
		return ""
	}
	return string(d.take(int(n)))
}

func (d *decoder) bytes32() []byte {
	n := d.u32()
	if d.err != nil {
		return nil
	}
	if n > maxRecordLen {
		d.err = errCorrupt
		return nil
	}
	b := d.take(int(n))
	if b == nil {
		return nil
	}
	return append([]byte(nil), b...)
}

func (d *decoder) window() Window {
	has := d.u8()
	high := d.u64()
	size := d.u32()
	nwords := d.u32()
	if d.err != nil {
		return Window{}
	}
	if size == 0 || size > maxWindowSize || nwords != (size+63)/64 {
		d.err = errCorrupt
		return Window{}
	}
	bits := make([]uint64, nwords)
	for i := range bits {
		bits[i] = d.u64()
	}
	if d.err != nil {
		return Window{}
	}
	w := Window{Has: has == 1, High: high, Size: int(size), Bits: bits}
	if r := w.Size % 64; r != 0 {
		w.Bits[len(w.Bits)-1] &= (uint64(1) << r) - 1
	}
	return w
}
