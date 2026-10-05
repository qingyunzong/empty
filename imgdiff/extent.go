// Package imgdiff compares sparse disk-image manifests and produces to build
// migration plans that rewrite one image into another.
//
// An image is described by a manifest: a virtual size plus a list of
// half-open extents [Start, End). Each extent is either a hole (reads as
// zero) or a data extent carrying an opaque content digest. A data extent
// whose bytes are all zero is flagged with Zero; it reads identically to a
// hole but has a different on-disk layout. Digests identify content: for
// meaningful cross-image comparison they should be computed at a consistent
// granularity (e.g. one digest per fixed-size block).
//
// A manifest may name a parent snapshot: regions not covered by the child's
// own extents are inherited from the parent, recursively.
package imgdiff

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

// Extent describes one half-open interval [Start, End) of an image.
type Extent struct {
	Start  uint64
	End    uint64
	Data   bool   // false: hole (reads as zero)
	Digest string // data only: opaque content identifier
	Zero   bool   // data only: content is all zero bytes
}

// Manifest is the JSON description of one image.
type Manifest struct {
	Size    uint64    `json:"size"`
	Parent  *Manifest `json:"parent,omitempty"`
	Extents []Extent  `json:"extents"`
}

// extentJSON is the wire form of an Extent.
type extentJSON struct {
	Start  uint64 `json:"start"`
	End    uint64 `json:"end"`
	Kind   string `json:"kind"` // "data" or "hole"
	Digest string `json:"digest,omitempty"`
	Zero   bool   `json:"zero,omitempty"`
}

// MarshalJSON implements json.Marshaler.
func (e Extent) MarshalJSON() ([]byte, error) {
	kind := "hole"
	if e.Data {
		kind = "data"
	}
	return json.Marshal(extentJSON{
		Start:  e.Start,
		End:    e.End,
		Kind:   kind,
		Digest: e.Digest,
		Zero:   e.Zero,
	})
}

// UnmarshalJSON implements json.Unmarshaler.
func (e *Extent) UnmarshalJSON(b []byte) error {
	var w extentJSON
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	switch w.Kind {
	case "data":
		if w.Digest == "" && !w.Zero {
			return fmt.Errorf("data extent [%d,%d): digest is required unless zero is set", w.Start, w.End)
		}
		e.Data = true
		e.Digest = w.Digest
		e.Zero = w.Zero
	case "hole":
		if w.Digest != "" || w.Zero {
			return fmt.Errorf("hole extent [%d,%d): must not carry digest or zero flag", w.Start, w.End)
		}
		e.Data = false
		e.Digest = ""
		e.Zero = false
	default:
		return fmt.Errorf("extent [%d,%d): kind must be \"data\" or \"hole\", got %q", w.Start, w.End, w.Kind)
	}
	e.Start = w.Start
	e.End = w.End
	return nil
}

// LoadManifest decodes and validates a manifest from r.
func LoadManifest(r io.Reader) (*Manifest, error) {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("decoding manifest: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate checks the manifest and all of its parents: extents must be
// well-formed, non-overlapping and inside [0, Size). Out-of-bounds extents
// are rejected.
func (m *Manifest) Validate() error {
	if _, err := m.Flatten(); err != nil {
		return err
	}
	return nil
}

// Flatten resolves the manifest against its parent chain and returns the
// effective sorted, non-overlapping extent list over [0, Size). Regions not
// covered by any extent are holes. Child extents take precedence over
// inherited parent extents; parent data beyond the child size is clipped.
func (m *Manifest) Flatten() ([]Extent, error) {
	own, err := normalize(m.Extents, m.Size)
	if err != nil {
		return nil, err
	}
	if m.Parent == nil {
		return own, nil
	}
	base, err := m.Parent.Flatten()
	if err != nil {
		return nil, fmt.Errorf("parent: %w", err)
	}
	// Clip inherited extents to the child size.
	clipped := base[:0]
	for _, e := range base {
		if e.Start >= m.Size {
			continue
		}
		if e.End > m.Size {
			e.End = m.Size
		}
		clipped = append(clipped, e)
	}
	return mergeLayers(clipped, own), nil
}

// normalize sorts extents and rejects malformed, overlapping or
// out-of-bounds intervals.
func normalize(extents []Extent, size uint64) ([]Extent, error) {
	out := make([]Extent, len(extents))
	copy(out, extents)
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	prevEnd := uint64(0)
	for i, e := range out {
		if e.End < e.Start {
			return nil, fmt.Errorf("extent %d: end %d < start %d", i, e.End, e.Start)
		}
		if e.End == e.Start {
			return nil, fmt.Errorf("extent %d: empty interval [%d,%d)", i, e.Start, e.End)
		}
		if e.End > size {
			return nil, fmt.Errorf("extent %d: [%d,%d) exceeds image size %d", i, e.Start, e.End, size)
		}
		if i > 0 && e.Start < prevEnd {
			return nil, fmt.Errorf("extent %d: [%d,%d) overlaps previous extent ending at %d", i, e.Start, e.End, prevEnd)
		}
		prevEnd = e.End
	}
	return out, nil
}

// mergeLayers overlays child extents on top of inherited parent extents.
// Both inputs are sorted and non-overlapping; child extents win.
func mergeLayers(parent, child []Extent) []Extent {
	var out []Extent
	ci := 0
	for _, p := range parent {
		// Child extents ending at or before p.Start cannot overlap p or
		// any later parent extent.
		for ci < len(child) && child[ci].End <= p.Start {
			ci++
		}
		fragStart := p.Start
		for j := ci; j < len(child) && child[j].Start < p.End; j++ {
			c := child[j]
			if c.Start > fragStart {
				out = append(out, Extent{Start: fragStart, End: c.Start, Data: p.Data, Digest: p.Digest, Zero: p.Zero})
			}
			if c.End >= p.End {
				fragStart = p.End
				break
			}
			fragStart = c.End
		}
		if fragStart < p.End {
			out = append(out, Extent{Start: fragStart, End: p.End, Data: p.Data, Digest: p.Digest, Zero: p.Zero})
		}
	}
	out = append(out, child...)
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}
