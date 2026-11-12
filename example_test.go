package dataeng

import "fmt"

// ExampleReadSST shows the handoff from a BIFF collector: the first payload is
// the SST record body and every later payload is a CONTINUE record body. The
// CONTINUE fragment below starts with 0x01 because the first string still has
// one character unit to read.
func ExampleReadSST() {
	sst := []byte{
		1, 0, 0, 0, // total references
		1, 0, 0, 0, // unique strings
		2, 0, // cch = 2 UTF-16 units
		0x01,       // string starts as double-byte
		0x41, 0x00, // 'A'
	}
	continuation := []byte{
		0x01,       // continuation width marker: still double-byte
		0x42, 0x00, // 'B'
	}

	table, err := ReadSST([]Fragment{
		NewSSTFragment(sst),
		NewContinueFragment(continuation),
	})
	if err != nil {
		panic(err)
	}
	fmt.Println(table.Strings[0].Text)
	fmt.Println(table.Strings[0].Units[1].Fragment, table.Strings[0].Units[1].Offset)

	// Output:
	// AB
	// 1 1
}
