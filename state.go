package telemetry

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// stateMagic identifies a serialized cursor snapshot.
const stateMagic = "TC01"

var errBadSnapshot = errors.New("telemetry: malformed snapshot")

// Snapshot serializes the reader's full state — bit order, cached bytes,
// cached bit length, and cursor — so decoding can pause at any bit and
// resume later, even in another process.
func (r *Reader) Snapshot() []byte {
	out := make([]byte, 0, 4+1+24+len(r.cache))
	out = append(out, stateMagic...)
	out = append(out, byte(r.order))
	var tmp [8]byte
	binary.LittleEndian.PutUint64(tmp[:], uint64(r.nbits))
	out = append(out, tmp[:]...)
	binary.LittleEndian.PutUint64(tmp[:], uint64(r.pos))
	out = append(out, tmp[:]...)
	binary.LittleEndian.PutUint64(tmp[:], uint64(len(r.cache)))
	out = append(out, tmp[:]...)
	out = append(out, r.cache...)
	return out
}

// RestoreReader rebuilds a Reader from a Snapshot. src, if non-nil,
// supplies bytes beyond those already cached.
func RestoreReader(snap []byte, src io.Reader) (*Reader, error) {
	order, nbits, pos, cache, err := parseSnapshot(snap)
	if err != nil {
		return nil, err
	}
	if pos > nbits {
		return nil, fmt.Errorf("%w: cursor %d beyond %d cached bits", errBadSnapshot, pos, nbits)
	}
	return &Reader{order: order, src: src, cache: cache, nbits: nbits, pos: pos}, nil
}

// Snapshot serializes the writer's full state.
func (w *Writer) Snapshot() []byte {
	out := make([]byte, 0, 4+1+24+len(w.buf))
	out = append(out, stateMagic...)
	out = append(out, byte(w.order))
	var tmp [8]byte
	binary.LittleEndian.PutUint64(tmp[:], uint64(w.nbits))
	out = append(out, tmp[:]...)
	binary.LittleEndian.PutUint64(tmp[:], uint64(w.nbits)) // writer cursor == nbits
	out = append(out, tmp[:]...)
	binary.LittleEndian.PutUint64(tmp[:], uint64(len(w.buf)))
	out = append(out, tmp[:]...)
	out = append(out, w.buf...)
	return out
}

// RestoreWriter rebuilds a Writer from a Snapshot.
func RestoreWriter(snap []byte) (*Writer, error) {
	order, nbits, pos, cache, err := parseSnapshot(snap)
	if err != nil {
		return nil, err
	}
	if pos != nbits {
		return nil, fmt.Errorf("%w: writer cursor %d != %d bits", errBadSnapshot, pos, nbits)
	}
	return &Writer{order: order, buf: cache, nbits: nbits}, nil
}

func parseSnapshot(snap []byte) (order BitOrder, nbits, pos int, cache []byte, err error) {
	if len(snap) < 4+1+24 || string(snap[:4]) != stateMagic {
		return 0, 0, 0, nil, errBadSnapshot
	}
	order = BitOrder(snap[4])
	if order != MSBFirst && order != LSBFirst {
		return 0, 0, 0, nil, fmt.Errorf("%w: bad bit order %d", errBadSnapshot, snap[4])
	}
	nb := binary.LittleEndian.Uint64(snap[5:13])
	p := binary.LittleEndian.Uint64(snap[13:21])
	cl := binary.LittleEndian.Uint64(snap[21:29])
	if nb > uint64(len(snap))*8 || p > nb || cl > uint64(len(snap)-29) {
		return 0, 0, 0, nil, errBadSnapshot
	}
	if uint64(len(snap)-29) != cl {
		return 0, 0, 0, nil, fmt.Errorf("%w: want %d cache bytes, got %d", errBadSnapshot, cl, len(snap)-29)
	}
	if nb > cl*8 {
		return 0, 0, 0, nil, fmt.Errorf("%w: %d bits in %d bytes", errBadSnapshot, nb, cl)
	}
	cache = make([]byte, cl)
	copy(cache, snap[29:])
	return order, int(nb), int(p), cache, nil
}
