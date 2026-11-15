package dataeng

import "encoding/binary"

const (
	fnvOffset64 = 14695981039346656037
	fnvPrime64  = 1099511628211
)

// slotForID assigns id to one of slots using rendezvous hashing. The score for
// a slot depends only on the ID, slot number, and salt, not on the current set
// of resources. That property makes the assignment stable when resources are
// added or removed, while still remapping only a small fraction of IDs if the
// number of slots changes.
func slotForID(id ID, slots int, salt string) int {
	if slots <= 1 {
		return 0
	}

	var slotBytes [8]byte
	bestSlot := 0
	var bestScore uint64

	for slot := 0; slot < slots; slot++ {
		h := uint64(fnvOffset64)
		h = fnvWriteString(h, salt)
		h = fnvWriteByte(h, 0)
		h = fnvWriteString(h, string(id))
		h = fnvWriteByte(h, 0)
		binary.LittleEndian.PutUint64(slotBytes[:], uint64(slot))
		for _, b := range slotBytes {
			h = fnvWriteByte(h, b)
		}

		score := mix64(h)
		if slot == 0 || score > bestScore {
			bestScore = score
			bestSlot = slot
		}
	}
	return bestSlot
}

func fnvWriteString(h uint64, s string) uint64 {
	for i := 0; i < len(s); i++ {
		h = fnvWriteByte(h, s[i])
	}
	return h
}

func fnvWriteByte(h uint64, b byte) uint64 {
	h ^= uint64(b)
	h *= fnvPrime64
	return h
}

// mix64 is the SplitMix64 finalizer. It gives the FNV output good avalanche
// behaviour, which keeps small slot counts reasonably balanced.
func mix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}
