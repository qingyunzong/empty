package dedup

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"time"
)

// checkpointMagic identifies the format and version of a snapshot.
var checkpointMagic = []byte("DEDUPCK1")

var errCorruptCheckpoint = errors.New("dedup: corrupt or incompatible checkpoint")

// Snapshot encodes the complete in-memory state of the Deduper — watermark,
// active window, exact set and every Bloom layer — into a deterministic
// byte slice. Because Bloom hashing is deterministic, a Deduper restored
// from this snapshot follows exactly the same false-positive path and can
// never produce false negatives relative to the snapshotted state.
//
// If the index implements CheckpointableIndex it is flushed first, so the
// returned snapshot and the durable index state form a consistent cut. On
// restart, restore both from the same checkpoint generation.
func (d *Deduper) Snapshot(ctx context.Context) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if ci, ok := d.index.(CheckpointableIndex); ok {
		if err := ci.Checkpoint(ctx); err != nil {
			return nil, fmt.Errorf("dedup: index checkpoint: %w", err)
		}
	}

	buf := append([]byte(nil), checkpointMagic...)
	buf = appendInt64(buf, timeOrZero(d.watermark))
	buf = appendInt64(buf, timeOrZero(d.windowStart))
	buf = appendInt64(buf, int64(d.cfg.WindowSize))
	buf = binary.AppendUvarint(buf, uint64(d.cfg.WindowCount))
	buf = binary.AppendUvarint(buf, uint64(d.cfg.ExpectedPerWindow))
	buf = appendUint64(buf, math.Float64bits(d.cfg.FalsePositiveRate))

	// Bloom parameters are shared by all layers; record them once. With no
	// layers yet, record what rotation will create.
	m, k := bloomParams(d.cfg)
	buf = binary.AppendUvarint(buf, m)
	buf = binary.AppendUvarint(buf, k)

	buf = binary.AppendUvarint(buf, uint64(len(d.exact)))
	for key := range d.exact {
		buf = binary.AppendUvarint(buf, uint64(len(key)))
		buf = append(buf, key...)
	}

	buf = binary.AppendUvarint(buf, uint64(len(d.layers)))
	for _, l := range d.layers {
		buf = appendInt64(buf, l.windowStart.UnixNano())
		buf = l.filter.appendTo(buf)
	}
	return buf, nil
}

// Restore rebuilds a Deduper from a Snapshot. The configuration is taken
// from the snapshot; the index must be the same persistent index (restored
// to the same checkpoint generation) that the snapshotted Deduper used.
func Restore(snapshot []byte, index Index) (*Deduper, error) {
	if index == nil {
		return nil, errors.New("dedup: index must not be nil")
	}
	if len(snapshot) < len(checkpointMagic) || string(snapshot[:len(checkpointMagic)]) != string(checkpointMagic) {
		return nil, errCorruptCheckpoint
	}
	off := len(checkpointMagic)
	r := byteReader{snapshot, &off}

	watermark, err := readInt64(r)
	if err != nil {
		return nil, err
	}
	windowStart, err := readInt64(r)
	if err != nil {
		return nil, err
	}
	windowSize, err := readInt64(r)
	if err != nil {
		return nil, err
	}
	windowCount, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, errCorruptCheckpoint
	}
	expected, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, errCorruptCheckpoint
	}
	fpBits, err := readUint64(r)
	if err != nil {
		return nil, err
	}
	m, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, errCorruptCheckpoint
	}
	k, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, errCorruptCheckpoint
	}

	cfg := Config{
		WindowSize:        time.Duration(windowSize),
		WindowCount:       int(windowCount),
		ExpectedPerWindow: int(expected),
		FalsePositiveRate: math.Float64frombits(fpBits),
	}
	if err := cfg.validate(); err != nil {
		return nil, errCorruptCheckpoint
	}
	if wantM, wantK := bloomParams(cfg); wantM != m || wantK != k {
		return nil, errCorruptCheckpoint
	}

	d := &Deduper{
		cfg:   cfg,
		index: index,
		exact: make(map[string]struct{}),
	}
	if watermark != 0 {
		d.watermark = time.Unix(0, watermark).UTC()
	}
	if windowStart != 0 {
		d.windowStart = time.Unix(0, windowStart).UTC()
	}

	nExact, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, errCorruptCheckpoint
	}
	for i := uint64(0); i < nExact; i++ {
		keyLen, err := binary.ReadUvarint(r)
		if err != nil || off+int(keyLen) > len(snapshot) {
			return nil, errCorruptCheckpoint
		}
		d.exact[string(snapshot[off:off+int(keyLen)])] = struct{}{}
		off += int(keyLen)
	}

	nLayers, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, errCorruptCheckpoint
	}
	if nLayers > uint64(cfg.WindowCount) {
		return nil, errCorruptCheckpoint
	}
	for i := uint64(0); i < nLayers; i++ {
		start, err := readInt64(r)
		if err != nil {
			return nil, err
		}
		filter, err := bloomFilterFromBytes(snapshot, &off, m, k)
		if err != nil {
			return nil, err
		}
		d.layers = append(d.layers, layer{
			windowStart: time.Unix(0, start).UTC(),
			filter:      filter,
		})
	}
	if off != len(snapshot) {
		return nil, errCorruptCheckpoint
	}
	return d, nil
}

// bloomParams computes the Bloom parameters rotation will use for cfg.
func bloomParams(cfg Config) (m, k uint64) {
	b := newBloomFilter(cfg.ExpectedPerWindow, cfg.FalsePositiveRate)
	return b.m, b.k
}

func timeOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixNano()
}

func appendInt64(buf []byte, v int64) []byte {
	return appendUint64(buf, uint64(v))
}

func appendUint64(buf []byte, v uint64) []byte {
	var tmp [8]byte
	binary.LittleEndian.PutUint64(tmp[:], v)
	return append(buf, tmp[:]...)
}

func readInt64(r byteReader) (int64, error) {
	v, err := readUint64(r)
	return int64(v), err
}

func readUint64(r byteReader) (uint64, error) {
	if *r.off+8 > len(r.data) {
		return 0, errCorruptCheckpoint
	}
	v := binary.LittleEndian.Uint64(r.data[*r.off:])
	*r.off += 8
	return v, nil
}
