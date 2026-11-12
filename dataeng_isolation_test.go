package dataeng_test

import (
	"bytes"
	"testing"

	dataeng "example.org/dataeng/q0266"
)

// TestPerWindowCacheReset proves the near ring and same table start at zero
// for every window, even though an earlier window populated them.
func TestPerWindowCacheReset(t *testing.T) {
	base, raw := baseline(t, "0123456789")
	span := int64(len(raw))

	// Window 1 fills near slot 0 and same row 0 col 4 with address 4.
	w1 := mustWindow(t, "primed", span, 0, []byte{raw[4]},
		[]dataeng.Instruction{
			dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: 4},
		})

	// Window 2 must observe fresh zero caches:
	//   near[0] + 0 -> address 0
	//   same row 0 col 4 -> address 0 (not 4)
	w2 := mustWindow(t, "fresh", span, 0, []byte{raw[0], raw[0]},
		[]dataeng.Instruction{
			dataeng.Copy{Mode: dataeng.CopyNear, Length: 1, OperandSlot: 0, Operand: 0},
			dataeng.Copy{Mode: dataeng.CopySame, Length: 1, OperandSlot: 0, Operand: 4},
		})

	res, _ := applyOK(t, base, []dataeng.Window{w1, w2}, dataeng.Limits{})
	want := []byte{raw[4], raw[0], raw[0]}
	if !bytes.Equal(res.Resource, want) {
		t.Fatalf("resource = %v, want %v (caches must reset per window)", res.Resource, want)
	}
}

// TestWindowCannotReadOtherWindowOutput ensures a later window's dictionary
// never includes bytes produced by earlier windows: its target starts empty
// and only the declared baseline interval is readable.
func TestWindowCannotReadOtherWindowOutput(t *testing.T) {
	base, _ := baseline(t, "abcdef")
	span := int64(6)

	w1 := mustWindow(t, "first", span, 0, []byte("zz"),
		[]dataeng.Instruction{dataeng.Run{Byte: 'z', Count: 2}})

	// Window 2's HERE starts at S + 0 (its own target is empty), so operand 1
	// resolves to address S-1 inside the baseline; it cannot reach w1 output.
	w2 := mustWindow(t, "second", span, 0, []byte{'f'},
		[]dataeng.Instruction{
			dataeng.Copy{Mode: dataeng.CopyHere, Length: 1, Operand: 1},
		})

	res, _ := applyOK(t, base, []dataeng.Window{w1, w2}, dataeng.Limits{})
	if string(res.Resource) != "zzf" {
		t.Fatalf("resource = %q, want zzf", res.Resource)
	}

	// A copy targeting the dictionary size of a fresh window must fail, since
	// the two 'z' bytes belong to window 1, not window 2's dictionary.
	bad := dataeng.Window{
		ID: "bad", Span: span, TargetLength: 1,
		Instructions: []dataeng.Instruction{
			dataeng.Copy{Mode: dataeng.CopySelf, Length: 1, Operand: span},
		},
	}
	applyErr(t, base, []dataeng.Window{bad}, dataeng.ErrAddress)
}
