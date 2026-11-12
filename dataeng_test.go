package dataeng_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"

	dataeng "example.org/dataeng/q0266"
)

func baseline(t *testing.T, payload string) (dataeng.Baseline, []byte) {
	t.Helper()
	raw := []byte(payload)
	return dataeng.Baseline{
		ReaderAt: bytes.NewReader(raw),
		Length:   int64(len(raw)),
		SHA256:   sha256.Sum256(raw),
	}, raw
}

func digest(b []byte) [32]byte { return sha256.Sum256(b) }

func mustWindow(t *testing.T, id string, span, base int64, target []byte, ins []dataeng.Instruction) dataeng.Window {
	t.Helper()
	return dataeng.Window{
		ID:           id,
		BaseOffset:   base,
		Span:         span,
		TargetLength: int64(len(target)),
		Instructions: ins,
		TargetSHA256: digest(target),
	}
}

func applyOK(t *testing.T, base dataeng.Baseline, ws []dataeng.Window, limits dataeng.Limits) (dataeng.Result, *dataeng.MemoryStore) {
	t.Helper()
	store := dataeng.NewMemoryStore()
	res, err := (&dataeng.Applier{Baseline: base, Store: store, Limits: limits}).Apply(context.Background(), ws)
	if err != nil {
		t.Fatalf("Apply failed: %v", err)
	}
	return res, store
}

func applyErr(t *testing.T, base dataeng.Baseline, ws []dataeng.Window, want error) {
	t.Helper()
	store := dataeng.NewMemoryStore()
	_, err := (&dataeng.Applier{Baseline: base, Store: store}).Apply(context.Background(), ws)
	if !errors.Is(err, want) {
		t.Fatalf("Apply error = %v, want %v", err, want)
	}
}

// TestNearRingWraparound drives five consecutive COPYs so the near ring
// overwrites slot 0 on the fifth COPY, then reuses the overwritten value.
func TestNearRingWraparound(t *testing.T) {
	base, _ := baseline(t, "ABCDEFGHIJ")
	span := int64(10)

	// Self copies fix addresses 0..4, shifting the ring from [0,1,2,3] to
	// [1,2,3,4]. Near slot 0 then holds 1. Every successful COPY (including
	// NEAR ones) advances the ring again.
	ins := []dataeng.Instruction{
		dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 0},
		dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 1},
		dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 2},
		dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 3},
		dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 4},
		dataeng.Copy{Mode: dataeng.CopyNear, Length: 2, OperandSlot: 0, Operand: 2}, // near[0]=1 -> addr 3 -> D,E; ring -> [2,3,4,3]
		dataeng.Copy{Mode: dataeng.CopyNear, Length: 2, OperandSlot: 3, Operand: 3}, // near[3]=3 -> addr 6 -> G,H
	}
	want := []byte("ABCDEDEGH")
	w := mustWindow(t, "near", span, 0, want, ins)

	res, store := applyOK(t, base, []dataeng.Window{w}, dataeng.Limits{})
	if !bytes.Equal(res.Resource, want) {
		t.Fatalf("resource = %q, want %q", res.Resource, want)
	}
	if len(res.Committed) != 1 || res.Committed[0] != "near" || len(res.Skipped) != 0 {
		t.Fatalf("commit accounting wrong: %+v", res)
	}
	if store.Commits != 1 || store.Lookups != 1 {
		t.Fatalf("store calls commits=%d lookups=%d", store.Commits, store.Lookups)
	}
}

// TestSameTableCollision verifies the row-major 768-entry same table: two
// addresses congruent mod 768 share one flat slot, and the later successful
// COPY overwrites the earlier value.
func TestSameTableCollision(t *testing.T) {
	raw := make([]byte, 1000)
	for i := range raw {
		raw[i] = byte(i % 256)
	}
	base := dataeng.Baseline{
		ReaderAt: bytes.NewReader(raw),
		Length:   int64(len(raw)),
		SHA256:   sha256.Sum256(raw),
	}
	span := int64(len(raw))

	// The same table is 768 row-major cells. Address 7 lands on cell 7
	// (row 0, col 7). Address 775 mod 768 is also 7, so it overwrites that
	// same cell, demonstrating same-slot collision. Row 2 col 7 is the
	// distinct cell 519 and is independently observed as still zero.
	ins := []dataeng.Instruction{
		dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 7},                 // writes cell 7 = 7
		dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 775},               // collides: cell 7 = 775
		dataeng.Copy{Mode: dataeng.CopySame, Length: 1, OperandSlot: 0, Operand: 7}, // reads collided 775
		dataeng.Copy{Mode: dataeng.CopySame, Length: 1, OperandSlot: 2, Operand: 7}, // cell 519 still zero
	}
	want := []byte{
		raw[7],   // self address 7
		raw[775], // self address 775; collides with cell 7 and overwrites it
		raw[775], // SAME row0 col7 now resolves to 775 (byte value happens to be 7)
		raw[0],   // row2 col7 is cell 519, never written -> address 0
	}
	w := mustWindow(t, "same", span, 0, want, ins)

	res, _ := applyOK(t, base, []dataeng.Window{w}, dataeng.Limits{})
	if !bytes.Equal(res.Resource, want) {
		t.Fatalf("resource = %v, want %v", res.Resource, want)
	}
}
