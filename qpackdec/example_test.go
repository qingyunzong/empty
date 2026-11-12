package qpackdec_test

import (
	"fmt"

	"example.org/dataeng/q0272/qpackdec"
)

// Example shows the host driving the receiver with already-parsed events:
// capacity updates, dynamic insertions and a header block that blocks on a
// not-yet-inserted entry before being released in order.
func Example() {
	static := []qpackdec.StaticField{
		{Name: ":method", Value: "GET"},
		{Name: ":path", Value: "/"},
	}
	dec, err := qpackdec.New(320, 4, static)
	if err != nil {
		panic(err)
	}
	if err := dec.SetCapacity(320); err != nil {
		panic(err)
	}

	// A block requiring R=2 (E=3 at I=0, K=10, F=20) referencing abs 1.
	block := qpackdec.HeaderBlock{
		StreamID:     1,
		EncodedCount: 3,
		Sign:         0,
		Delta:        0,
		Fields: []qpackdec.Field{
			{Kind: qpackdec.FieldRelative, Index: 0}, // base 2, i=0 -> abs 1
		},
	}
	if _, err := dec.HeaderBlockReceived(block); err != nil {
		panic(err)
	}
	fmt.Println("blocked:", dec.BlockedStreams())

	if _, err := dec.Insert("name0", "value0"); err != nil { // I=1
		panic(err)
	}
	delivered, err := dec.Insert("name1", "value1") // I=2 -> releases block
	if err != nil {
		panic(err)
	}
	for _, dl := range delivered {
		f := dl.Header.Fields[0]
		fmt.Printf("stream %d -> %s=%s (dynamic abs %d)\n",
			dl.StreamID, f.Name, f.Value, f.DynamicIndex)
	}
	// Output:
	// blocked: 1
	// stream 1 -> name1=value1 (dynamic abs 1)
}
