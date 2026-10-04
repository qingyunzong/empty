package intervalx

import (
	"bytes"
	"encoding/gob"
	"errors"
	"hash/fnv"
)

// ErrCrash is panicked by fault injectors to simulate a crash mid-publish.
var ErrCrash = errors.New("intervalx: simulated crash")

// FaultInjector is called at every publish fault point. A nil Hook does
// nothing; a test injector panics with ErrCrash to simulate a crash.
// Points, in order: "invalidate", "midData", "data", "meta", "commit".
// Crashing at "commit" means the new tree is already visible.
type FaultInjector interface {
	Hook(point string)
}

// rootSlot is one durable image of a version.
type rootSlot struct {
	epoch uint64
	sum   uint64
	data  []byte
	valid bool
}

// Root is a persistent root holding the published Version. It uses two
// slots plus an atomic commit pointer so that recovery after a crash at
// any point yields either the complete old or the complete new tree,
// never a mixture.
type Root struct {
	slots  [2]rootSlot
	active int // -1 when nothing has been published
	inj    FaultInjector
}

// NewRoot returns an empty Root. inj may be nil.
func NewRoot(inj FaultInjector) *Root {
	return &Root{active: -1, inj: inj}
}

func (r *Root) hook(point string) {
	if r.inj != nil {
		r.inj.Hook(point)
	}
}

// Publish atomically replaces the published version with v. If a crash
// (injected fault) interrupts it, Recover still returns a consistent
// version.
func (r *Root) Publish(v *Version) error {
	target := 0
	if r.active == 0 {
		target = 1
	}
	data, err := encodeVersion(v)
	if err != nil {
		return err
	}
	r.hook("invalidate")
	r.slots[target].valid = false
	half := len(data) / 2
	r.slots[target].data = data[:half]
	r.hook("midData")
	r.slots[target].data = data
	r.hook("data")
	r.slots[target].epoch = v.Epoch()
	r.slots[target].sum = checksum(data)
	r.slots[target].valid = true
	r.hook("meta")
	r.active = target // atomic commit
	r.hook("commit")
	return nil
}

// Recover returns the last consistently published version: the active slot
// if its image is intact, otherwise the previous slot, otherwise an empty
// version. A partially written slot is detected via its checksum and
// never mixed with the other slot.
func (r *Root) Recover() *Version {
	if v, ok := r.trySlot(r.active); ok {
		return v
	}
	other := 1 - r.active
	if r.active < 0 {
		other = 0
	}
	if v, ok := r.trySlot(other); ok {
		return v
	}
	return New()
}

func (r *Root) trySlot(i int) (*Version, bool) {
	if i < 0 {
		return nil, false
	}
	s := r.slots[i]
	if !s.valid || checksum(s.data) != s.sum {
		return nil, false
	}
	v, err := decodeVersion(s.data)
	if err != nil || v.Epoch() != s.epoch {
		return nil, false
	}
	return v, true
}

func checksum(data []byte) uint64 {
	h := fnv.New64a()
	h.Write(data)
	return h.Sum64()
}

type versionDisk struct {
	Epoch     uint64
	Intervals []SourcedInterval
}

func encodeVersion(v *Version) ([]byte, error) {
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(versionDisk{Epoch: v.epoch, Intervals: v.Intervals()}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func decodeVersion(data []byte) (*Version, error) {
	var d versionDisk
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&d); err != nil {
		return nil, err
	}
	v := New()
	v.epoch = d.Epoch
	for _, si := range d.Intervals {
		v.bySrc[si.Source] = append(v.bySrc[si.Source], si.Interval)
	}
	return v, nil
}
