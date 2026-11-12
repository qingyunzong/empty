package dataeng_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"

	dataeng "example.org/dataeng/q0266"
)

// TestResourceIsOrderedConcatenation proves the final resource is committed
// windows concatenated in input order, regardless of ID lexicographic order.
func TestResourceIsOrderedConcatenation(t *testing.T) {
	base, _ := baseline(t, "base-bytes")
	mk := func(id, out string) dataeng.Window {
		return mustWindow(t, id, int64(len("base-bytes")), 0, []byte(out),
			[]dataeng.Instruction{dataeng.Add{Bytes: []byte(out)}})
	}
	ws := []dataeng.Window{mk("c", "C-"), mk("a", "A-"), mk("b", "B-")}

	res, store := applyOK(t, base, ws, dataeng.Limits{})
	if string(res.Resource) != "C-A-B-" {
		t.Fatalf("resource = %q, want C-A-B-", res.Resource)
	}
	if got := store.Snapshot(); len(got) != 3 {
		t.Fatalf("stored windows = %d, want 3", len(got))
	}

	// Reapply a reordered subset: store lookup still joins content in the new
	// input order without reinterpreting anything.
	res2, err := (&dataeng.Applier{Baseline: base, Store: store}).Apply(
		context.Background(), []dataeng.Window{ws[1], ws[0]})
	if err != nil {
		t.Fatalf("reorder replay failed: %v", err)
	}
	if string(res2.Resource) != "A-C-" || len(res2.Skipped) != 2 {
		t.Fatalf("reordered replay wrong: %+v resource=%q", res2, res2.Resource)
	}
}

// TestBaselineIntervalOffset uses a window whose dictionary is a sub-interval
// of the baseline, so dictionary address 0 maps to BaseOffset.
func TestBaselineIntervalOffset(t *testing.T) {
	base, raw := baseline(t, "PREFIX-hello-world-SUFFIX")
	start := int64(7) // points at 'h'
	span := int64(11) // "hello-world"

	ins := []dataeng.Instruction{
		dataeng.Copy{Mode: dataeng.CopySelf, Length: span, Operand: 0},
	}
	want := raw[start : start+span]
	w := mustWindow(t, "sub", span, start, want, ins)

	res, _ := applyOK(t, base, []dataeng.Window{w}, dataeng.Limits{})
	if !bytes.Equal(res.Resource, want) {
		t.Fatalf("resource = %q, want %q", res.Resource, want)
	}

	// Interval extending past the baseline end is rejected.
	outside := mustWindow(t, "outside", span, int64(len(raw))-3, want, ins)
	applyErr(t, base, []dataeng.Window{outside}, dataeng.ErrOverflow)
}

func TestBaselineFingerprintMismatch(t *testing.T) {
	base, _ := baseline(t, "abc")
	base.SHA256[0] ^= 0xFF
	w := mustWindow(t, "w", 3, 0, []byte("a"),
		[]dataeng.Instruction{dataeng.Add{Bytes: []byte("a")}})
	applyErr(t, base, []dataeng.Window{w}, dataeng.ErrBaselineDigest)
}

func TestDuplicateWindowID(t *testing.T) {
	base, _ := baseline(t, "abc")
	mk := func(id string) dataeng.Window {
		return mustWindow(t, id, 3, 0, []byte("a"),
			[]dataeng.Instruction{dataeng.Add{Bytes: []byte("a")}})
	}
	applyErr(t, base, []dataeng.Window{mk("dup"), mk("dup")}, dataeng.ErrDuplicateWindow)
}

func TestConflictOnDifferentInstructions(t *testing.T) {
	base, _ := baseline(t, "abc")
	store := dataeng.NewMemoryStore()
	app := &dataeng.Applier{Baseline: base, Store: store}

	w1 := mustWindow(t, "id", 3, 0, []byte("a"),
		[]dataeng.Instruction{dataeng.Add{Bytes: []byte("a")}})
	if _, err := app.Apply(context.Background(), []dataeng.Window{w1}); err != nil {
		t.Fatalf("first apply: %v", err)
	}

	// Same ID and same target text, but different instruction list: the
	// canonical instruction hash differs and the store must reject it.
	w2 := mustWindow(t, "id", 3, 0, []byte("a"),
		[]dataeng.Instruction{dataeng.Run{Byte: 'a', Count: 1}})
	_, err := app.Apply(context.Background(), []dataeng.Window{w2})
	if !errors.Is(err, dataeng.ErrConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}

	// Same ID against a different baseline fingerprint is also a conflict.
	otherBase := base
	otherBase.SHA256 = sha256.Sum256([]byte("different-baseline!!"))
	otherBase.ReaderAt = bytes.NewReader([]byte("different-baseline!!"))
	otherBase.Length = int64(len("different-baseline!!"))
	_, err = (&dataeng.Applier{Baseline: otherBase, Store: store}).Apply(
		context.Background(), []dataeng.Window{w1})
	if !errors.Is(err, dataeng.ErrConflict) {
		t.Fatalf("expected baseline conflict, got %v", err)
	}
}

func TestLimits(t *testing.T) {
	base, _ := baseline(t, "abcdefgh")
	big := mustWindow(t, "big", 8, 0, bytes.Repeat([]byte("a"), 100),
		[]dataeng.Instruction{dataeng.Run{Byte: 'a', Count: 100}})

	store := dataeng.NewMemoryStore()
	_, err := (&dataeng.Applier{
		Baseline: base,
		Store:    store,
		Limits:   dataeng.Limits{MaxWindowBytes: 50, MaxTotalBytes: 50},
	}).Apply(context.Background(), []dataeng.Window{big})
	if !errors.Is(err, dataeng.ErrLimit) {
		t.Fatalf("window limit: got %v, want ErrLimit", err)
	}

	small1 := mustWindow(t, "s1", 8, 0, []byte("aa"),
		[]dataeng.Instruction{dataeng.Run{Byte: 'a', Count: 2}})
	small2 := mustWindow(t, "s2", 8, 0, []byte("bbb"),
		[]dataeng.Instruction{dataeng.Run{Byte: 'b', Count: 3}})
	_, err = (&dataeng.Applier{
		Baseline: base,
		Store:    dataeng.NewMemoryStore(),
		Limits:   dataeng.Limits{MaxWindowBytes: 3, MaxTotalBytes: 4},
	}).Apply(context.Background(), []dataeng.Window{small1, small2})
	if !errors.Is(err, dataeng.ErrLimit) {
		t.Fatalf("total limit: got %v, want ErrLimit", err)
	}

	// Within limits succeeds.
	res, _ := applyOK(t, base, []dataeng.Window{small1, small2}, dataeng.Limits{
		MaxWindowBytes: 3,
		MaxTotalBytes:  5,
	})
	if string(res.Resource) != "aabbb" {
		t.Fatalf("resource = %q", res.Resource)
	}
}

func TestRejectBadInstructionsAndAddresses(t *testing.T) {
	base, _ := baseline(t, "abc")
	badWindow := func(id string, ins dataeng.Instruction) dataeng.Window {
		return dataeng.Window{ID: id, Span: 3, TargetLength: 1, Instructions: []dataeng.Instruction{ins}}
	}

	cases := []struct {
		name string
		w    dataeng.Window
		want error
	}{
		{
			"zero run",
			badWindow("z", dataeng.Run{Byte: 'a', Count: 0}),
			dataeng.ErrZeroLength,
		},
		{
			"zero copy length",
			badWindow("z", dataeng.Copy{Mode: dataeng.CopySelf, Length: 0}),
			dataeng.ErrZeroLength,
		},
		{
			"unknown copy mode",
			badWindow("z", dataeng.Copy{Mode: 99, Length: 1}),
			dataeng.ErrBadMode,
		},
		{
			"self outside dictionary",
			badWindow("z", dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 99}),
			dataeng.ErrAddress,
		},
		{
			"near slot out of range",
			badWindow("z", dataeng.Copy{Mode: dataeng.CopyNear, Length: 1, OperandSlot: 4}),
			dataeng.ErrAddress,
		},
		{
			"same row out of range",
			badWindow("z", dataeng.Copy{Mode: dataeng.CopySame, Length: 1, OperandSlot: 3, Operand: 1}),
			dataeng.ErrAddress,
		},
		{
			"same index out of range",
			badWindow("z", dataeng.Copy{Mode: dataeng.CopySame, Length: 1, Operand: 256}),
			dataeng.ErrAddress,
		},
		{
			"declared length mismatch",
			dataeng.Window{
				ID: "z", Span: 3, TargetLength: 2,
				Instructions: []dataeng.Instruction{dataeng.Add{Bytes: []byte("a")}},
				TargetSHA256: digest([]byte("a")),
			},
			dataeng.ErrLength,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			applyErr(t, base, []dataeng.Window{tc.w}, tc.want)
		})
	}
}

func TestTargetDigestMismatchRejectsAndDoesNotCommit(t *testing.T) {
	base, _ := baseline(t, "abc")
	store := dataeng.NewMemoryStore()
	w := dataeng.Window{
		ID: "w", Span: 3, TargetLength: 1,
		Instructions: []dataeng.Instruction{dataeng.Add{Bytes: []byte("a")}},
		TargetSHA256: digest([]byte("not-a")),
	}
	_, err := (&dataeng.Applier{Baseline: base, Store: store}).Apply(context.Background(), []dataeng.Window{w})
	if !errors.Is(err, dataeng.ErrTargetDigest) {
		t.Fatalf("got %v, want target digest error", err)
	}
	if len(store.Snapshot()) != 0 {
		t.Fatal("failed window must not leave partial committed state")
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	base, _ := baseline(t, "abcdefgh")
	w := mustWindow(t, "codec", 8, 2, []byte("hello!!"), []dataeng.Instruction{
		dataeng.Add{Bytes: []byte("hello")},
		dataeng.Run{Byte: '!', Count: 2},
		dataeng.Copy{Mode: dataeng.CopyNear, Length: 3, Operand: 4, OperandSlot: 2},
		dataeng.Copy{Mode: dataeng.CopyHere, Length: 1, Operand: 2},
		dataeng.Copy{Mode: dataeng.CopySame, Length: 1, Operand: 7, OperandSlot: 1},
		dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 3},
	})

	encoded, err := dataeng.EncodeWindow(w)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	decoded, err := dataeng.DecodeWindow(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	if decoded.ID != w.ID || decoded.Span != w.Span || decoded.BaseOffset != w.BaseOffset ||
		decoded.TargetLength != w.TargetLength || decoded.TargetSHA256 != w.TargetSHA256 ||
		len(decoded.Instructions) != len(w.Instructions) {
		t.Fatalf("decoded header mismatch: %+v", decoded)
	}
	for i := range w.Instructions {
		if !instructionEqual(w.Instructions[i], decoded.Instructions[i]) {
			t.Fatalf("instruction %d mismatch: %#v vs %#v", i, w.Instructions[i], decoded.Instructions[i])
		}
	}

	// Tampered input must fail to decode.
	tampered := append([]byte(nil), encoded...)
	tampered[len(tampered)-1] ^= 0xFF
	if _, err := dataeng.DecodeWindow(tampered); err == nil {
		t.Fatal("expected decode failure on tampered bytes")
	}

	// The decoded window remains executable against the baseline (only its
	// self/near/here/same addresses need to be valid; build a valid one).
	valid := mustWindow(t, "codec-ok", 8, 0, []byte("a"),
		[]dataeng.Instruction{dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 0}})
	enc, err := dataeng.EncodeWindow(valid)
	if err != nil {
		t.Fatalf("encode valid: %v", err)
	}
	decValid, err := dataeng.DecodeWindow(enc)
	if err != nil {
		t.Fatalf("decode valid: %v", err)
	}
	res, _ := applyOK(t, base, []dataeng.Window{decValid}, dataeng.Limits{})
	if string(res.Resource) != "a" {
		t.Fatalf("decoded window produced %q", res.Resource)
	}
}

func instructionEqual(a, b dataeng.Instruction) bool {
	switch av := a.(type) {
	case dataeng.Add:
		bv, ok := b.(dataeng.Add)
		return ok && bytes.Equal(av.Bytes, bv.Bytes)
	case dataeng.Run:
		bv, ok := b.(dataeng.Run)
		return ok && av == bv
	case dataeng.Copy:
		bv, ok := b.(dataeng.Copy)
		return ok && av == bv
	default:
		return false
	}
}
