package lzw

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
)

// Checkpoint captures the decoder state just before a code is read: the
// bit cursor, the current code width, and a digest of the complete live
// dictionary, plus a digest of the compressed source prefix. A checkpoint
// is a verification anchor: restoring it re-derives the dictionary by
// decoding the source from the beginning up to the checkpoint's bit
// cursor and then checks every field, so a checkpoint cannot be applied
// to a different source or to a dictionary rebuilt after a clear code.
type Checkpoint struct {
	CodeIndex int    // index of the next code to read
	BitPos    uint64 // bit cursor into the compressed source
	Width     uint   // current code width in bits
	Hi        uint16 // next dictionary code to assign
	Last      int32  // most recent code, or -1 right after a clear
	OutLen    int    // decompressed bytes produced so far
	SrcLen    int    // bytes of source covered by SrcHash
	SrcHash   [sha256.Size]byte
	DictHash  [sha256.Size]byte
}

func (d *decoder) checkpoint() Checkpoint {
	last := int32(d.last)
	if d.last == invalidCode {
		last = -1
	}
	srcLen := int((d.bitPos + 7) / 8)
	return Checkpoint{
		CodeIndex: d.codeIndex,
		BitPos:    d.bitPos,
		Width:     d.width,
		Hi:        d.hi,
		Last:      last,
		OutLen:    d.outLen,
		SrcLen:    srcLen,
		SrcHash:   d.srcHash(srcLen),
		DictHash:  d.dictHash(),
	}
}

// srcHash digests data[:srcLen]. When the decoder runs in checkpointing
// mode (srcHasher set), prefixes are digested incrementally as the bit
// cursor only moves forward.
func (d *decoder) srcHash(srcLen int) [sha256.Size]byte {
	if d.srcHasher == nil || srcLen < d.srcFed {
		return sha256.Sum256(d.data[:srcLen])
	}
	d.srcHasher.Write(d.data[d.srcFed:srcLen])
	d.srcFed = srcLen
	var sum [sha256.Size]byte
	d.srcHasher.Sum(sum[:0])
	return sum
}

// dictHash digests the complete live dictionary: every entry in
// [firstDictCode, hi) as (prefix, suffix) pairs, framed by the fields
// that define the decoder state. Entries abandoned by a clear code are
// excluded, so the digest changes across a clear.
func (d *decoder) dictHash() [sha256.Size]byte {
	h := sha256.New()
	var buf [2]byte
	binary.LittleEndian.PutUint16(buf[:], d.hi)
	h.Write(buf[:])
	binary.LittleEndian.PutUint16(buf[:], d.last)
	h.Write(buf[:])
	h.Write([]byte{byte(d.width)})
	for c := uint16(firstDictCode); c < d.hi; c++ {
		binary.LittleEndian.PutUint16(buf[:], d.prefix[c])
		h.Write(buf[:])
		h.Write(d.suffix[c : c+1 : c+1])
	}
	var sum [sha256.Size]byte
	h.Sum(sum[:0])
	return sum
}

func (d *decoder) verify(cp *Checkpoint) error {
	last := int32(d.last)
	if d.last == invalidCode {
		last = -1
	}
	if d.codeIndex != cp.CodeIndex || d.bitPos != cp.BitPos ||
		d.width != cp.Width || d.hi != cp.Hi ||
		last != cp.Last || d.outLen != cp.OutLen {
		return fmt.Errorf("%w: decoder state at code %d differs", ErrCheckpoint, cp.CodeIndex)
	}
	srcLen := int((cp.BitPos + 7) / 8)
	if srcLen != cp.SrcLen || srcLen > len(d.data) ||
		sha256.Sum256(d.data[:srcLen]) != cp.SrcHash {
		return fmt.Errorf("%w: source prefix at code %d differs", ErrCheckpoint, cp.CodeIndex)
	}
	if d.dictHash() != cp.DictHash {
		return fmt.Errorf("%w: dictionary at code %d differs", ErrCheckpoint, cp.CodeIndex)
	}
	return nil
}

// DecodeCheckpoints decodes a complete stream like Decode and additionally
// returns a checkpoint captured before every code, including the EOF code.
func DecodeCheckpoints(data []byte) ([]byte, []Checkpoint, error) {
	return DecodeCheckpointEvery(data, 1)
}

// DecodeCheckpointEvery decodes a complete stream like Decode and returns
// a checkpoint captured before every code whose index is a multiple of
// every (clamped to >= 1).
func DecodeCheckpointEvery(data []byte, every int) ([]byte, []Checkpoint, error) {
	if every < 1 {
		every = 1
	}
	d := newDecoder(data)
	d.srcHasher = sha256.New()
	var out []byte
	var cps []Checkpoint
	for {
		if d.codeIndex%every == 0 {
			cps = append(cps, d.checkpoint())
		}
		done, err := d.step(&out)
		if err != nil {
			return nil, nil, err
		}
		if done {
			if err := d.checkTrailing(); err != nil {
				return nil, nil, err
			}
			return out, cps, nil
		}
	}
}

// SelectCheckpoint returns the latest checkpoint at or before the given
// code index, or nil if there is none.
func SelectCheckpoint(cps []Checkpoint, start int) *Checkpoint {
	best := -1
	for i := range cps {
		if cps[i].CodeIndex <= start && (best < 0 || cps[i].CodeIndex > cps[best].CodeIndex) {
			best = i
		}
	}
	if best < 0 {
		return nil
	}
	return &cps[best]
}

// DecodeRange decompresses the output produced by the codes with indexes
// in [start, end); a negative end decodes through the EOF code and
// validates the stream tail. If cp is non-nil it must satisfy
// cp.CodeIndex <= start; the decoder fast-forwards to the checkpoint,
// verifies it against the re-derived state (including the source prefix
// and the full dictionary digest), and continues from there.
func DecodeRange(data []byte, start, end int, cp *Checkpoint) ([]byte, error) {
	if start < 0 || (end >= 0 && end < start) {
		return nil, fmt.Errorf("lzw: bad range [%d, %d)", start, end)
	}
	d := newDecoder(data)
	if cp != nil {
		if cp.CodeIndex > start {
			return nil, fmt.Errorf("lzw: checkpoint at code %d is after range start %d", cp.CodeIndex, start)
		}
		for d.bitPos < cp.BitPos {
			done, err := d.step(nil)
			if err != nil {
				return nil, err
			}
			if done {
				return nil, fmt.Errorf("%w: EOF before checkpoint at code %d", ErrCheckpoint, cp.CodeIndex)
			}
		}
		if err := d.verify(cp); err != nil {
			return nil, err
		}
	}
	for d.codeIndex < start {
		done, err := d.step(nil)
		if err != nil {
			return nil, err
		}
		if done {
			return nil, fmt.Errorf("lzw: range start %d beyond end of stream", start)
		}
	}
	var out []byte
	for end < 0 || d.codeIndex < end {
		done, err := d.step(&out)
		if err != nil {
			return nil, err
		}
		if done {
			if end >= 0 && d.codeIndex < end {
				return nil, fmt.Errorf("lzw: range end %d beyond end of stream", end)
			}
			if end < 0 {
				if err := d.checkTrailing(); err != nil {
					return nil, err
				}
			}
			break
		}
	}
	return out, nil
}
