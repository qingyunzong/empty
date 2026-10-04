package sim

// RNG is a deterministic splitmix64 generator with an explicitly
// serializable state, so snapshots can capture and restore it exactly.
type RNG struct {
	state uint64
}

func NewRNG(seed uint64) RNG {
	return RNG{state: seed}
}

func (r *RNG) Next() uint64 {
	r.state += 0x9E3779B97F4A7C15
	z := r.state
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// Intn returns a deterministic value in [0, n). n must be > 0.
func (r *RNG) Intn(n int) int {
	return int(r.Next() % uint64(n))
}

// State exposes the raw state for snapshots.
func (r *RNG) State() uint64 { return r.state }

// SetState restores a previously captured state.
func (r *RNG) SetState(s uint64) { r.state = s }
