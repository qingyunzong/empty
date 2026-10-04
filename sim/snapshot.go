package sim

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
)

// Snapshot captures the complete simulator state needed to resume:
// node liveness, the full pending (in-flight) message queue, the RNG
// state, the message-id counter, and the current event index.
type Snapshot struct {
	Nodes    []bool
	Pending  []Message
	RNGState uint64
	NextID   uint64
	Step     int
}

// Snapshot returns a deep copy of the resumable state.
func (s *Simulator) Snapshot() *Snapshot {
	nodes := make([]bool, len(s.nodes))
	copy(nodes, s.nodes)
	pending := make([]Message, len(s.pending))
	copy(pending, s.pending)
	return &Snapshot{
		Nodes:    nodes,
		Pending:  pending,
		RNGState: s.rng.State(),
		NextID:   s.nextID,
		Step:     s.step,
	}
}

// Restore replaces the simulator state with the snapshot contents.
// The output log is intentionally not part of the snapshot: after a
// restore, newly produced output can be compared byte-for-byte against
// the corresponding suffix of a full replay.
func (s *Simulator) Restore(snap *Snapshot) {
	s.nodes = make([]bool, len(snap.Nodes))
	copy(s.nodes, snap.Nodes)
	s.pending = make([]Message, len(snap.Pending))
	copy(s.pending, snap.Pending)
	s.rng.SetState(snap.RNGState)
	s.nextID = snap.NextID
	s.step = snap.Step
	s.out.Reset()
}

const (
	snapMagic   = 0x53494D31 // "SIM1"
	snapVersion = 1
)

// Marshal encodes the snapshot into a deterministic binary form.
func (snap *Snapshot) Marshal() []byte {
	buf := new(bytes.Buffer)
	w := func(v any) { _ = binary.Write(buf, binary.LittleEndian, v) }
	w(uint32(snapMagic))
	w(uint32(snapVersion))
	w(uint64(snap.Step))
	w(snap.NextID)
	w(snap.RNGState)
	w(uint32(len(snap.Nodes)))
	for _, up := range snap.Nodes {
		var b uint8
		if up {
			b = 1
		}
		w(b)
	}
	w(uint32(len(snap.Pending)))
	for _, m := range snap.Pending {
		w(m.ID)
		w(int32(m.Src))
		w(int32(m.Dst))
		w(m.Body)
		w(int32(m.Dup))
	}
	return buf.Bytes()
}

// UnmarshalSnapshot decodes a snapshot produced by Marshal.
func UnmarshalSnapshot(data []byte) (*Snapshot, error) {
	r := bytes.NewReader(data)
	rd := func(v any) error { return binary.Read(r, binary.LittleEndian, v) }
	var magic, version uint32
	if err := rd(&magic); err != nil || magic != snapMagic {
		return nil, errors.New("sim: bad snapshot magic")
	}
	if err := rd(&version); err != nil || version != snapVersion {
		return nil, fmt.Errorf("sim: unsupported snapshot version %d", version)
	}
	snap := &Snapshot{}
	var step, nextID, rngState uint64
	if err := rd(&step); err != nil {
		return nil, err
	}
	if err := rd(&nextID); err != nil {
		return nil, err
	}
	if err := rd(&rngState); err != nil {
		return nil, err
	}
	snap.Step = int(step)
	snap.NextID = nextID
	snap.RNGState = rngState

	var nNodes uint32
	if err := rd(&nNodes); err != nil {
		return nil, err
	}
	snap.Nodes = make([]bool, nNodes)
	for i := range snap.Nodes {
		var b uint8
		if err := rd(&b); err != nil {
			return nil, err
		}
		snap.Nodes[i] = b == 1
	}

	var nPending uint32
	if err := rd(&nPending); err != nil {
		return nil, err
	}
	snap.Pending = make([]Message, nPending)
	for i := range snap.Pending {
		m := &snap.Pending[i]
		var src, dst, dup int32
		if err := rd(&m.ID); err != nil {
			return nil, err
		}
		if err := rd(&src); err != nil {
			return nil, err
		}
		if err := rd(&dst); err != nil {
			return nil, err
		}
		if err := rd(&m.Body); err != nil {
			return nil, err
		}
		if err := rd(&dup); err != nil {
			return nil, err
		}
		m.Src, m.Dst, m.Dup = int(src), int(dst), int(dup)
	}
	if r.Len() != 0 {
		return nil, errors.New("sim: trailing bytes in snapshot")
	}
	return snap, nil
}
