package desim

// RNG is a deterministic pseudo-random number generator (splitmix64)
// whose entire state is a single uint64, so it can be captured and
// restored exactly by snapshots.
type RNG struct {
	state uint64
}

// NewRNG returns an RNG seeded with seed.
func NewRNG(seed uint64) *RNG {
	return &RNG{state: seed}
}

// Uint64 advances the state and returns the next 64-bit value.
func (r *RNG) Uint64() uint64 {
	r.state += 0x9E3779B97F4A7C15
	z := r.state
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// Int63 implements rand.Source.
func (r *RNG) Int63() int64 {
	return int64(r.Uint64() >> 1)
}

// Seed implements rand.Source.
func (r *RNG) Seed(seed int64) {
	r.state = uint64(seed)
}

// Intn returns a non-negative value in [0, n). It panics if n <= 0.
func (r *RNG) Intn(n int) int {
	if n <= 0 {
		panic("desim: Intn with non-positive n")
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
