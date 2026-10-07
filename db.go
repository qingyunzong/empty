package dedup

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"sync"
)

// Op is a single effect applied atomically with its dedup record.
type Op struct {
	Key   string
	Value string
}

// Put builds a key/value effect op.
func Put(key, value string) Op { return Op{Key: key, Value: value} }

const frameHeaderLen = 8 // uint32 payload length + uint32 CRC-32

// DB combines the dedup Set with a WAL. Each accepted message is persisted
// as one framed record carrying both the dedup marker (producer, seq) and
// its effects, so the two are durable — or lost — together. Power loss can
// therefore never replay an effect: either the record survived (and the
// redelivered message is a duplicate) or it did not (and the message is
// reprocessed from scratch).
type DB struct {
	mu   sync.Mutex
	f    File
	set  *Set
	data map[string]string
	off  int64 // end of the valid WAL
	err  error // sticky error: after a failed write the DB must be reopened
}

// Open opens (or creates) the WAL at path and recovers its state.
func Open(path string, windowSize int) (*DB, error) {
	f, err := OpenFile(path)
	if err != nil {
		return nil, err
	}
	return OpenWithFile(f, windowSize)
}

// OpenWithFile recovers a DB from an arbitrary File implementation.
func OpenWithFile(f File, windowSize int) (*DB, error) {
	db := &DB{f: f, set: NewSet(windowSize), data: make(map[string]string)}
	if err := db.recover(); err != nil {
		f.Close()
		return nil, err
	}
	return db, nil
}

// recover replays frames until the first invalid or torn one, then
// truncates the tail so future appends start at a clean boundary.
func (db *DB) recover() error {
	var hdr [frameHeaderLen]byte
	for {
		if _, err := db.f.ReadAt(hdr[:], db.off); err != nil {
			if !errors.Is(err, io.EOF) {
				return err
			}
			break // clean or torn header: stop
		}
		length := binary.LittleEndian.Uint32(hdr[0:4])
		crc := binary.LittleEndian.Uint32(hdr[4:8])
		if length > 1<<30 {
			break // corrupt header
		}
		payload := make([]byte, length)
		if _, err := db.f.ReadAt(payload, db.off+frameHeaderLen); err != nil {
			if !errors.Is(err, io.EOF) {
				return err
			}
			break // torn payload
		}
		if crc32.ChecksumIEEE(payload) != crc {
			break // torn or corrupt frame
		}
		producer, seq, ops, err := decodePayload(payload)
		if err != nil {
			return err // a committed frame must decode
		}
		db.set.Observe(producer, seq)
		for _, op := range ops {
			db.data[op.Key] = op.Value
		}
		db.off += frameHeaderLen + int64(length)
	}
	// Best-effort tail cleanup: a torn tail is skipped on every recovery,
	// so failing to remove it here is safe.
	if err := db.f.Truncate(db.off); err == nil {
		_ = db.f.Sync()
	}
	return nil
}

// Apply records (producer, seq) and, iff it is new, atomically persists and
// applies the effect ops in the same batch. Duplicate and too-old messages
// apply nothing. After a write-boundary error the DB is poisoned and must
// be closed and reopened; Apply returns the sticky error until then.
func (db *DB) Apply(producer string, seq uint64, ops ...Op) (Decision, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.err != nil {
		return 0, db.err
	}
	dec := db.set.Observe(producer, seq)
	if dec != New {
		return dec, nil
	}
	frame := encodeFrame(producer, seq, ops)
	if _, err := db.f.WriteAt(frame, db.off); err != nil {
		db.err = err
		return 0, err
	}
	if err := db.f.Sync(); err != nil {
		db.err = err
		return 0, err
	}
	db.off += int64(len(frame))
	for _, op := range ops {
		db.data[op.Key] = op.Value
	}
	return New, nil
}

// Get returns the current value of an effect key.
func (db *DB) Get(key string) (string, bool) {
	db.mu.Lock()
	defer db.mu.Unlock()
	v, ok := db.data[key]
	return v, ok
}

// Close closes the underlying file.
func (db *DB) Close() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.f.Close()
}

func encodeFrame(producer string, seq uint64, ops []Op) []byte {
	var payload []byte
	payload = binary.AppendUvarint(payload, seq)
	payload = binary.AppendUvarint(payload, uint64(len(producer)))
	payload = append(payload, producer...)
	payload = binary.AppendUvarint(payload, uint64(len(ops)))
	for _, op := range ops {
		payload = binary.AppendUvarint(payload, uint64(len(op.Key)))
		payload = append(payload, op.Key...)
		payload = binary.AppendUvarint(payload, uint64(len(op.Value)))
		payload = append(payload, op.Value...)
	}
	frame := make([]byte, 0, frameHeaderLen+len(payload))
	frame = binary.LittleEndian.AppendUint32(frame, uint32(len(payload)))
	frame = binary.LittleEndian.AppendUint32(frame, crc32.ChecksumIEEE(payload))
	return append(frame, payload...)
}

func decodePayload(p []byte) (producer string, seq uint64, ops []Op, err error) {
	r := &reader{p: p}
	seq = r.uvarint()
	producer = r.str()
	n := r.uvarint()
	for i := uint64(0); i < n && r.err == nil; i++ {
		ops = append(ops, Op{Key: r.str(), Value: r.str()})
	}
	if r.err == nil && len(r.p) != 0 {
		r.err = errors.New("trailing bytes in frame payload")
	}
	if r.err != nil {
		return "", 0, nil, fmt.Errorf("decode frame: %w", r.err)
	}
	return producer, seq, ops, nil
}

type reader struct {
	p   []byte
	err error
}

func (r *reader) uvarint() uint64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Uvarint(r.p)
	if n <= 0 {
		r.err = errors.New("bad uvarint")
		return 0
	}
	r.p = r.p[n:]
	return v
}

func (r *reader) str() string {
	n := r.uvarint()
	if r.err != nil {
		return ""
	}
	if uint64(len(r.p)) < n {
		r.err = errors.New("short string")
		return ""
	}
	s := string(r.p[:n])
	r.p = r.p[n:]
	return s
}
