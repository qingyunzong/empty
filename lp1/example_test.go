package lp1_test

import (
	"fmt"

	"example.org/dataeng/q0317/lp1"
)

// ExampleHostPageEditing shows an archive host opening an untrusted page,
// walking it from both ends, then splicing in replacement values under a byte
// budget. The old snapshot and its cursors stay valid when the budget rejects
// an edit.
func Example_hostPageEditing() {
	page := lp1.EmptyPage()
	snap, err := lp1.Open(page)
	if err != nil {
		panic(err)
	}

	// Ingest two initial elements at the tail.
	snap, err = snap.Splice(0, 0,
		[]lp1.Value{lp1.Integer(-4096), lp1.String([]byte("payload"))}, 0)
	if err != nil {
		panic(err)
	}

	// Inspect the last element using the reverse length; no header rescan.
	tail := snap.Tail()
	last, _ := tail.Prev()
	fmt.Println("last type:", last.Value.Type(), "bytes:", string(last.Value.Bytes()))

	// Replace the string element with two integers; the untouched integer keeps
	// its exact on-page encoding even if it had been a wide encoding.
	updated, err := snap.Splice(1, 1,
		[]lp1.Value{lp1.Integer(4095), lp1.Integer(127)}, 0)
	if err != nil {
		panic(err)
	}

	head := updated.Head()
	for {
		el, ok := head.Next()
		if !ok {
			break
		}
		if el.Value.Type() == lp1.TypeInteger {
			fmt.Println("int:", el.Value.Int())
		}
	}

	// A deliberately tight budget fails without producing a half page: the
	// previous snapshot remains fully usable.
	_, err = updated.Splice(3, 0, []lp1.Value{lp1.String(make([]byte, 64))},
		uint64(len(updated.Bytes())))
	fmt.Println("budget error:", err == lp1.ErrCapacity)

	// Output:
	// last type: 1 bytes: payload
	// int: -4096
	// int: 4095
	// int: 127
	// budget error: true
}
