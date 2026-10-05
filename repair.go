package mirror

import "errors"

// ErrVersionSkew is returned when the source version changes between
// the diff and the block fetches, which would mix two source versions
// into one repair publication.
var ErrVersionSkew = errors.New("mirror: source version changed during repair")

// Report describes a completed repair.
type Report struct {
	SourceVersion uint64
	Repaired      []int
}

// Repair makes dst match src. It pins the source version, diffs the
// published trees, fetches only the differing leaves, and refuses to
// publish a mix of two source versions: any source mutation mid-repair
// aborts with ErrVersionSkew before dst is touched further.
func Repair(dst *Mirror, src Source) (*Report, error) {
	v := src.Version()
	tree := src.Tree()
	if src.Version() != v {
		return nil, ErrVersionSkew
	}
	leaves := Diff(dst.Tree(), tree)
	for _, i := range leaves {
		data, ok := src.ReadBlock(i)
		if src.Version() != v {
			return nil, ErrVersionSkew
		}
		if ok {
			dst.WriteBlock(i, data)
		} else {
			dst.ClearBlock(i)
		}
	}
	if src.Version() != v {
		return nil, ErrVersionSkew
	}
	return &Report{SourceVersion: v, Repaired: leaves}, nil
}
