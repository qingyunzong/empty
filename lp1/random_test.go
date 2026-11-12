package lp1_test

import (
	"math/rand/v2"
	"testing"

	"example.org/dataeng/q0317/lp1"
)

func randomValue(r *rand.Rand) fixValue {
	switch r.IntN(10) {
	case 0:
		return fixInteger([]int64{0, 127, 128, -1, -4096, 4095, -4097, 4096,
			-8388608, 8388607, -2147483648, 2147483647,
			-9223372036854775808, 9223372036854775807}[r.IntN(14)])
	case 1:
		return fixInteger(r.Int64())
	case 2:
		return fixString(nil)
	default:
		n := []int{1, 2, 63, 64, 65, 126, 127, 128, 4095, 4096, 5000}[r.IntN(11)]
		payload := make([]byte, n)
		for i := range payload {
			payload[i] = byte(r.IntN(256))
		}
		return fixString(payload)
	}
}

func TestRandomSpliceSequence(t *testing.T) {
	r := rand.New(rand.NewPCG(0x9e3779b97f4a7c15, 0x14057b7ef767814f))

	// Occasionally begin from a page that declares the unknown header count.
	seedElems := []fixElement{
		fixBuildElement(mustEncode(lp1.Integer(-4096))),
		fixBuildElement(mustEncode(lp1.String(bytesOf(4096, 7)))),
	}
	snap := mustOpen(t, fixBuildPage(seedElems, true))
	model := make([]fixElement, len(seedElems))
	copy(model, seedElems)

	for iter := 0; iter < 300; iter++ {
		start := r.IntN(len(model) + 1)
		maxDelete := len(model) - start
		deleteCount := r.IntN(maxDelete + 1)
		newCount := r.IntN(4)
		newValues := make([]lp1.Value, newCount)
		newElems := make([]fixElement, newCount)
		for i := 0; i < newCount; i++ {
			fv := randomValue(r)
			newValues[i] = fv.toValue()
			newElems[i] = fixBuildElement(mustEncode(fv.toValue()))
		}

		next, err := snap.Splice(start, deleteCount, newValues, 0)
		if err != nil {
			t.Fatalf("iter %d splice: %v", iter, err)
		}

		// Mirror the same edit in the independent raw-byte model. Fresh backing
		// arrays avoid append overwriting elements still referenced by model.
		prefix := make([]fixElement, start)
		copy(prefix, model[:start])
		tail := make([]fixElement, len(model)-start-deleteCount)
		copy(tail, model[start+deleteCount:])
		model = append(append(append(make([]fixElement, 0, len(prefix)+len(newElems)+len(tail)),
			prefix...), newElems...), tail...)

		verifyModel(t, next, model, iter)
		snap = next
	}
}

func verifyModel(t *testing.T, snap *lp1.Snapshot, model []fixElement, iter int) {
	t.Helper()

	// Independent full-decode fixture must accept the produced page.
	decoded, err := fixDecodePage(snap.Bytes())
	if err != nil {
		t.Fatalf("iter %d independent decode: %v", iter, err)
	}
	if len(decoded) != len(model) {
		t.Fatalf("iter %d model length %d decoded %d", iter, len(model), len(decoded))
	}
	for i := range model {
		if string(decoded[i].raw) != string(model[i].raw) {
			t.Fatalf("iter %d element %d raw bytes differ", iter, i)
		}
		if !fixEqual(model[i].value, forwardElementValue(snap, i)) {
			got := forwardElementValue(snap, i)
			t.Fatalf("iter %d element %d value differs: model kind=%d num=%d strLen=%d; got kind=%d num=%d strLen=%d",
				iter, i, model[i].value.kind, model[i].value.num, len(model[i].value.str),
				got.Type(), got.Int(), len(got.Bytes()))
		}
	}

	if snap.Count() != uint64(len(model)) {
		t.Fatalf("iter %d count %d model %d", iter, snap.Count(), len(model))
	}
	wantHeader := uint16(len(model))
	if len(model) >= 65535 {
		wantHeader = 65535
	}
	if snap.HeaderCount() != wantHeader {
		t.Fatalf("iter %d header %d want %d", iter, snap.HeaderCount(), wantHeader)
	}

	// Forward and backward traversal must be exact reverses.
	fwd := forwardValues(t, snap)
	bwd := backwardValues(t, snap)
	if len(fwd) != len(model) || len(bwd) != len(model) {
		t.Fatalf("iter %d traversal lengths", iter)
	}
	for i := range model {
		if !fixEqual(model[i].value, fwd[i]) {
			t.Fatalf("iter %d forward value %d", iter, i)
		}
		if !fixEqual(model[len(model)-1-i].value, bwd[i]) {
			t.Fatalf("iter %d reverse value %d", iter, i)
		}
	}
}

func forwardElementValue(snap *lp1.Snapshot, idx int) lp1.Value {
	cur := snap.Head()
	for i := 0; i <= idx; i++ {
		el, ok := cur.Next()
		if !ok {
			panic("model out of range")
		}
		if i == idx {
			return el.Value
		}
	}
	panic("unreachable")
}

func TestRandomSmallPages(t *testing.T) {
	// A second, independently seeded run starting from an empty page.
	r := rand.New(rand.NewPCG(0xdeadbeefcafebabe, 0x0123456789abcdef))
	snap, err := lp1.Open(lp1.EmptyPage())
	if err != nil {
		t.Fatal(err)
	}
	var model []fixElement
	for iter := 0; iter < 200; iter++ {
		start := r.IntN(len(model) + 1)
		deleteCount := r.IntN(len(model) - start + 1)
		newCount := r.IntN(3)
		newValues := make([]lp1.Value, newCount)
		newElems := make([]fixElement, newCount)
		for i := 0; i < newCount; i++ {
			fv := randomValue(r)
			newValues[i] = fv.toValue()
			newElems[i] = fixBuildElement(mustEncode(fv.toValue()))
		}
		next, err := snap.Splice(start, deleteCount, newValues, 0)
		if err != nil {
			t.Fatalf("iter %d: %v", iter, err)
		}
		prefix := make([]fixElement, start)
		copy(prefix, model[:start])
		tail := make([]fixElement, len(model)-start-deleteCount)
		copy(tail, model[start+deleteCount:])
		model = append(append(append(make([]fixElement, 0, len(prefix)+len(newElems)+len(tail)),
			prefix...), newElems...), tail...)
		verifyModel(t, next, model, iter)
		snap = next
	}
}
