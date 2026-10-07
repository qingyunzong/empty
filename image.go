// Package imgdiff compares sparse images described by extent lists and
// produces relocation plans that transform an old image into a new one.
//
// An image is a list of extents over [0, Size). Data extents carry their
// bytes; holes read as zeros. A zero-filled data block and a hole are equal
// in content but different in layout. Data extents may be shared with a
// parent snapshot; shared blocks are read-only and must be unshared before
// being overwritten.
package imgdiff

import (
	"errors"
	"fmt"
	"math"
)

// Kind classifies an extent.
type Kind int

const (
	// Hole reads as zeros and stores nothing.
	Hole Kind = iota
	// Data stores bytes; may be shared with a parent snapshot.
	Data
)

func (k Kind) String() string {
	if k == Data {
		return "data"
	}
	return "hole"
}

// Extent describes one half-open interval [Start, Start+Len).
type Extent struct {
	Start  uint64
	Len    uint64
	Kind   Kind
	Shared bool   // backed by parent snapshot storage; read-only until unshared
	Data   []byte // exactly Len bytes when Kind == Data
}

// End returns the exclusive end offset.
func (e Extent) End() uint64 { return e.Start + e.Len }

// Image is a sparse image: a size plus a sorted, non-overlapping extent
// list. Gaps between extents are holes.
type Image struct {
	Size    uint64
	Extents []Extent
}

// Validate checks structural invariants and rejects out-of-range intervals:
// offsets are uint64, Start+Len must not overflow, extents must be sorted,
// non-overlapping, non-empty and within [0, Size).
func (img *Image) Validate() error {
	if img == nil {
		return errors.New("imgdiff: nil image")
	}
	prevEnd := uint64(0)
	for i, e := range img.Extents {
		if e.Len == 0 {
			return fmt.Errorf("imgdiff: extent %d: zero length", i)
		}
		if e.Start > math.MaxUint64-e.Len {
			return fmt.Errorf("imgdiff: extent %d: [%d, +%d) overflows uint64", i, e.Start, e.Len)
		}
		if e.End() > img.Size {
			return fmt.Errorf("imgdiff: extent %d: [%d, %d) out of range, size %d", i, e.Start, e.End(), img.Size)
		}
		if i > 0 && e.Start < prevEnd {
			return fmt.Errorf("imgdiff: extent %d: [%d, %d) overlaps or out of order (previous end %d)", i, e.Start, e.End(), prevEnd)
		}
		switch e.Kind {
		case Data:
			if uint64(len(e.Data)) != e.Len {
				return fmt.Errorf("imgdiff: extent %d: data length %d != extent length %d", i, len(e.Data), e.Len)
			}
		case Hole:
			if len(e.Data) != 0 {
				return fmt.Errorf("imgdiff: extent %d: hole extent carries data", i)
			}
			if e.Shared {
				return fmt.Errorf("imgdiff: extent %d: hole cannot be shared", i)
			}
		default:
			return fmt.Errorf("imgdiff: extent %d: unknown kind %d", i, int(e.Kind))
		}
		prevEnd = e.End()
	}
	return nil
}

// Normalized returns a copy of the extent list with explicit hole extents
// filling every gap, so the result covers [0, Size) completely. Adjacent
// hole extents are merged.
func (img *Image) Normalized() []Extent {
	var out []Extent
	pos := uint64(0)
	emitHole := func(start, end uint64) {
		if end > start {
			out = append(out, Extent{Start: start, Len: end - start, Kind: Hole})
		}
	}
	for _, e := range img.Extents {
		emitHole(pos, e.Start)
		out = append(out, e)
		pos = e.End()
	}
	emitHole(pos, img.Size)
	return out
}

// Interval is a half-open interval [Start, End).
type Interval struct {
	Start uint64
	End   uint64
}

func (iv Interval) String() string { return fmt.Sprintf("[%d, %d)", iv.Start, iv.End) }

// dataImage builds an image of n data blocks from raw bytes. Testing helper
// used by the CLI exec state and by tests.
func dataImage(size uint64, data []byte) *Image {
	img := &Image{Size: size}
	if size > 0 {
		img.Extents = []Extent{{Start: 0, Len: size, Kind: Data, Data: data}}
	}
	return img
}
