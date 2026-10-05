package sim

// RNG is a deterministic pseudo-random number generator (splitmix64).
// Its entire state is a single uint64, so a snapshot captures it exactly
// and a restore reproduces the exact draw sequence.
type RNG struct {
	state uint64
}

// NewRNG returns an RNG seeded with seed.
func NewRNG(seed uint64) *RNG {
	return &RNG{state: seed}
}

// Uint64 returns the next pseudo-random uint64.
func (r *RNG) Uint64() uint64 {
	r.state += 0x9E3779B97F4A7C15
	z := r.state
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// Float64 returns a pseudo-random value in [0, 1).
func (r *RNG) Float64() float64 {
	return float64(r.Uint64()>>11) * (1.0 / (1 << 53))
}

// Intn returns a pseudo-random value in [0, n). It panics if n <= 0.
func (r *RNG) Intn(n int) int {
	if n <= 0 {
		panic("sim: Intn with non-positive n")
	}
	return int(r.Uint64() % uint64(n))
}

// State returns the full generator state, suitable for snapshots.
func (r *RNG) State() uint64 {
	return r.state
}

// SetState restores a state previously obtained from State.
func (r *RNG) SetState(state uint64) {
	r.state = state
}
