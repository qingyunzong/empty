package telemcodec

import "io"

// BitReader reads bits from an io.Reader (or a preloaded byte slice) using a
// BitOrder. Bytes pulled from the source are cached; rolling the cursor back
// never discards cached bytes, so failed speculative reads cost no I/O.
type BitReader struct {
	order BitOrder
	src   io.Reader // may be nil once the cache holds everything
	cache []byte
	pos   int64 // cursor in bits
	limit int64 // available bits; -1 means limited only by src
}

// NewBitReader wraps an io.Reader. Bytes are cached as they are pulled.
func NewBitReader(src io.Reader, order BitOrder) *BitReader {
	if !order.valid() {
		order = MSBFirst
	}
	return &BitReader{order: order, src: src, limit: -1}
}

// NewBitReaderBytes reads from b; the stream ends exactly at len(b)*8 bits.
func NewBitReaderBytes(b []byte, order BitOrder) *BitReader {
	r := NewBitReader(nil, order)
	r.cache = append(r.cache, b...)
	r.limit = int64(len(b)) * 8
	return r
}

// SetBitLimit restricts the readable stream to n bits, simulating a
// truncated stream. Cached bytes beyond the limit are retained, so raising
// the limit again allows reads to continue without re-fetching.
func (r *BitReader) SetBitLimit(n int64) { r.limit = n }

// Pos returns the cursor in bits.
func (r *BitReader) Pos() int64 { return r.pos }

// CachedBits returns how many bits are currently held in the cache.
func (r *BitReader) CachedBits() int64 { return int64(len(r.cache)) * 8 }

// Mark records the cursor for Rollback.
func (r *BitReader) Mark() int64 { return r.pos }

// Rollback returns the cursor to a previous Mark. Cached source bytes are
// kept, so re-reading after a rollback performs no I/O.
func (r *BitReader) Rollback(mark int64) {
	if mark < 0 || mark > r.pos {
		return
	}
	r.pos = mark
}

// ensure makes nbits available from the cursor, pulling from src into the
// cache as needed. The cursor is never moved here.
func (r *BitReader) ensure(nbits int) error {
	need := r.pos + int64(nbits)
	if r.limit >= 0 && need > r.limit {
		return ErrTruncated
	}
	for int64(len(r.cache))*8 < need {
		if r.src == nil {
			return ErrTruncated
		}
		want := int((need - int64(len(r.cache))*8 + 7) / 8)
		if want < 1 {
			want = 1
		}
		chunk := make([]byte, want)
		n, err := r.src.Read(chunk)
		if n > 0 {
			r.cache = append(r.cache, chunk[:n]...)
		}
		if err != nil {
			return ErrTruncated
		}
		if n == 0 {
			return ErrTruncated
		}
	}
	return nil
}

func (r *BitReader) bitAt(p int64) uint64 {
	b := r.cache[p>>3]
	if r.order == MSBFirst {
		return uint64(b>>(7-uint(p&7))) & 1
	}
	return uint64(b>>uint(p&7)) & 1
}

// ReadBits reads n bits (0..64). On failure the cursor does not advance.
func (r *BitReader) ReadBits(n int) (uint64, error) {
	if n < 0 || n > 64 {
		return 0, ErrInvalid
	}
	if err := r.ensure(n); err != nil {
		return 0, err
	}
	var v uint64
	if r.order == MSBFirst {
		for k := 0; k < n; k++ {
			v = v<<1 | r.bitAt(r.pos+int64(k))
		}
	} else {
		for k := 0; k < n; k++ {
			v |= r.bitAt(r.pos+int64(k)) << uint(k)
		}
	}
	r.pos += int64(n)
	return v, nil
}

// ReadSigned reads an n-bit two's-complement integer and sign-extends it.
// On failure the cursor does not advance.
func (r *BitReader) ReadSigned(n int) (int64, error) {
	if n < 1 || n > 64 {
		return 0, ErrInvalid
	}
	u, err := r.ReadBits(n)
	if err != nil {
		return 0, err
	}
	if n == 64 {
		return int64(u), nil
	}
	if u&(uint64(1)<<uint(n-1)) != 0 {
		return int64(u) - (int64(1) << uint(n)), nil
	}
	return int64(u), nil
}

// Align skips zero bits up to the next byte boundary and returns the
// padding bit range [start, end). On failure the cursor does not advance.
func (r *BitReader) Align() (start, end int64, err error) {
	pad := int((8 - r.pos&7) & 7)
	start = r.pos
	if pad == 0 {
		return start, start, nil
	}
	if _, err := r.ReadBits(pad); err != nil {
		return 0, 0, err
	}
	return start, r.pos, nil
}

// ReadUvarint reads an unsigned LEB128 varint. Overlong (non-minimal)
// encodings and values exceeding 64 bits are rejected; on any error the
// cursor returns to where the read started.
func (r *BitReader) ReadUvarint() (uint64, error) {
	mark := r.pos
	var v uint64
	for i := 0; i < 10; i++ {
		b, err := r.ReadBits(8)
		if err != nil {
			r.pos = mark
			return 0, err
		}
		if i == 9 && b > 1 {
			r.pos = mark
			return 0, ErrOverflow
		}
		v |= (b & 0x7f) << uint(7*i)
		if b&0x80 == 0 {
			if i > 0 && b == 0 {
				r.pos = mark
				return 0, ErrOverlong
			}
			return v, nil
		}
	}
	r.pos = mark
	return 0, ErrOverflow
}

// ReadVarint reads a zigzag-encoded signed varint with the same rejection
// and rollback rules as ReadUvarint.
func (r *BitReader) ReadVarint() (int64, error) {
	u, err := r.ReadUvarint()
	if err != nil {
		return 0, err
	}
	return int64(u>>1) ^ -int64(u&1), nil
}
