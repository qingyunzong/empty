package telemcodec

import (
	"encoding/binary"
	"io"
)

// ReaderState is a serializable snapshot of a BitReader: the bit order, the
// bit-granular cursor, the bit limit, and every source byte cached so far.
// Restoring a state needs no access to the original stream for the cached
// prefix; pass the original source to Resume to continue past it.
type ReaderState struct {
	Order BitOrder
	Pos   int64
	Limit int64 // -1 means unlimited
	Cache []byte
}

var stateMagic = []byte{'T', 'C', 'S', '1'}

// Snapshot captures the reader so a read can be paused at any bit and
// resumed later, possibly in another process.
func (r *BitReader) Snapshot() ReaderState {
	return ReaderState{
		Order: r.order,
		Pos:   r.pos,
		Limit: r.limit,
		Cache: append([]byte(nil), r.cache...),
	}
}

// Marshal encodes the state into a self-contained binary form.
func (s ReaderState) Marshal() []byte {
	out := make([]byte, 0, 4+1+8+8+8+len(s.Cache))
	out = append(out, stateMagic...)
	out = append(out, byte(s.Order))
	var tmp [8]byte
	binary.LittleEndian.PutUint64(tmp[:], uint64(s.Pos))
	out = append(out, tmp[:]...)
	binary.LittleEndian.PutUint64(tmp[:], uint64(s.Limit))
	out = append(out, tmp[:]...)
	binary.LittleEndian.PutUint64(tmp[:], uint64(len(s.Cache)))
	out = append(out, tmp[:]...)
	out = append(out, s.Cache...)
	return out
}

// UnmarshalReaderState decodes a state produced by Marshal.
func UnmarshalReaderState(b []byte) (ReaderState, error) {
	if len(b) < 4+1+8+8+8 {
		return ReaderState{}, ErrInvalid
	}
	if string(b[:4]) != string(stateMagic) {
		return ReaderState{}, ErrInvalid
	}
	order := BitOrder(b[4])
	if !order.valid() {
		return ReaderState{}, ErrInvalid
	}
	pos := int64(binary.LittleEndian.Uint64(b[5:13]))
	limit := int64(binary.LittleEndian.Uint64(b[13:21]))
	n := binary.LittleEndian.Uint64(b[21:29])
	if uint64(len(b)-29) != n {
		return ReaderState{}, ErrInvalid
	}
	if pos < 0 || pos > int64(n)*8 {
		return ReaderState{}, ErrInvalid
	}
	if limit >= 0 && pos > limit {
		return ReaderState{}, ErrInvalid
	}
	return ReaderState{
		Order: order,
		Pos:   pos,
		Limit: limit,
		Cache: append([]byte(nil), b[29:]...),
	}, nil
}

// Resume rebuilds a BitReader from a snapshot. src may be nil; if the
// snapshot's cache does not cover a future read and src is nil, reads fail
// with ErrTruncated exactly as they would at end of stream.
func Resume(s ReaderState, src io.Reader) *BitReader {
	return &BitReader{
		order: s.Order,
		src:   src,
		cache: append([]byte(nil), s.Cache...),
		pos:   s.Pos,
		limit: s.Limit,
	}
}
