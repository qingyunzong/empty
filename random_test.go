package dataeng

import (
	"math/rand"
	"testing"
)

func TestRandomAgainstReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for caseIndex := 0; caseIndex < 20; caseIndex++ {
		n := rng.Intn(1025)
		b := 1 + rng.Intn(63)
		S := 1 + rng.Intn(4096)
		bits := make([]byte, n)
		for i := range bits {
			bits[i] = byte(rng.Intn(2))
		}
		checkAgainstReference(t, bits, b, S)
	}
}
