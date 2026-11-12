package dataeng

import (
	"encoding/binary"
	"math/rand"
	"testing"
)

func sparsePayload(t *testing.T, p int, threshold uint32, entries map[uint32]uint8) []byte {
	t.Helper()
	var b []byte
	b = append(b, formatMagic...)
	b = append(b, formatVersion, byte(p))
	b = binary.BigEndian.AppendUint16(b, uint16(len(testHashID)))
	b = append(b, testHashID...)
	b = binary.BigEndian.AppendUint32(b, threshold)
	b = append(b, repSparse)
	b = binary.BigEndian.AppendUint32(b, uint32(len(entries)))
	for idx, rho := range entries {
		b = binary.BigEndian.AppendUint32(b, idx)
		b = append(b, rho)
	}
	return b
}

func TestRoundTripSparseAndDense(t *testing.T) {
	rng := rand.New(rand.NewSource(10))
	hasher := testHasher(rand.New(rand.NewSource(11)))

	sparse := mustNew(t, 8, 256, hasher)
	for i := 0; i < 20; i++ {
		sparse.AddHash(rng.Uint64())
	}
	dense := mustNew(t, 8, 4, hasher)
	for i := 0; i < 50; i++ {
		dense.AddHash(rng.Uint64())
	}
	if !dense.IsDense() {
		t.Fatal("fixture should be dense")
	}

	for name, original := range map[string]*Sketch{"sparse": sparse, "dense": dense} {
		data, err := original.MarshalBinary()
		if err != nil {
			t.Fatalf("%s marshal: %v", name, err)
		}
		restored, err := Unmarshal(hasher, data)
		if err != nil {
			t.Fatalf("%s unmarshal: %v", name, err)
		}
		if restored.Precision() != original.Precision() ||
			restored.HashID() != original.HashID() ||
			restored.SparseThreshold() != original.SparseThreshold() ||
			restored.IsDense() != original.IsDense() ||
			!sameRegisters(restored.Registers(), original.Registers()) {
			t.Fatalf("%s round trip changed state", name)
		}

		// Restored sketches must accept further updates equivalently.
		extra := make([]uint64, 30)
		for i := range extra {
			extra[i] = rng.Uint64()
		}
		for _, h := range extra {
			original.AddHash(h)
			restored.AddHash(h)
		}
		if !sameRegisters(restored.Registers(), original.Registers()) {
			t.Fatalf("%s updates after restore diverged", name)
		}
	}
}

func TestUnmarshalRejectsMalformedPayloads(t *testing.T) {
	hasher := testHasher(rand.New(rand.NewSource(12)))
	good := mustNew(t, 6, 64, hasher)
	good.AddHash(7)
	good.AddHash(9)
	data, err := good.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}

	// Trailing junk.
	if _, err := Unmarshal(hasher, append(append([]byte{}, data...), 0xFF)); err == nil {
		t.Fatal("trailing junk must be rejected")
	}
	// Truncation.
	if _, err := Unmarshal(hasher, data[:len(data)-1]); err == nil {
		t.Fatal("truncated payload must be rejected")
	}
	// Bad magic / unsupported version.
	badMagic := append([]byte{}, data...)
	badMagic[0] = 'X'
	if _, err := Unmarshal(hasher, badMagic); err == nil {
		t.Fatal("bad magic must be rejected")
	}
	badVersion := append([]byte{}, data...)
	badVersion[4] = 99
	if _, err := Unmarshal(hasher, badVersion); err == nil {
		t.Fatal("unknown version must be rejected")
	}

	// Duplicate sparse index.
	dup := sparsePayload(t, 6, 64, map[uint32]uint8{})
	dup = binary.BigEndian.AppendUint32(dup, 7)
	dup = append(dup, 2)
	dup = binary.BigEndian.AppendUint32(dup, 7)
	dup = append(dup, 5)
	// The header count must be rewritten from 0 to 2.
	countPos := 4 + 1 + 1 + 2 + len(testHashID) + 4 + 1
	binary.BigEndian.PutUint32(dup[countPos:], 2)
	if _, err := Unmarshal(hasher, dup); err == nil {
		t.Fatal("duplicate sparse index must be rejected")
	}

	// Out of range rho inside a sparse entry.
	badRho := sparsePayload(t, 6, 64, map[uint32]uint8{3: uint8(65 - 6 + 1)})
	if _, err := Unmarshal(hasher, badRho); err == nil {
		t.Fatal("out of range rho must be rejected")
	}

	// Out of range sparse index.
	badIdx := sparsePayload(t, 6, 64, map[uint32]uint8{64: 1})
	if _, err := Unmarshal(hasher, badIdx); err == nil {
		t.Fatal("out of range sparse index must be rejected")
	}

	// Sparse entry count violating the configured threshold.
	violating := sparsePayload(t, 6, 1, map[uint32]uint8{1: 1})
	if _, err := Unmarshal(hasher, violating); err == nil {
		t.Fatal("sparse entries reaching threshold must be rejected")
	}

	// Dense payload with an out of range rho.
	dense := mustNew(t, 6, 1, hasher)
	dense.AddHash(1)
	denseData, err := dense.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	denseBad := append([]byte{}, denseData...)
	denseBad[len(denseBad)-1] = uint8(65 - 6 + 1)
	if _, err := Unmarshal(hasher, denseBad); err == nil {
		t.Fatal("dense out of range rho must be rejected")
	}

	if _, err := Unmarshal(nil, data); err == nil {
		t.Fatal("nil hasher must be rejected")
	}
	blank := &Sketch{hasher: hasher}
	if err := blank.UnmarshalBinary(nil); err == nil {
		t.Fatal("empty payload must be rejected")
	}
}
