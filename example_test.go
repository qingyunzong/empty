package formal

import (
	"errors"
	"fmt"
	"net/netip"
)

func ExampleTable() {
	tbl, err := NewTable(Config{
		Backends: []Backend{
			{ID: "api-1", Addr: "10.0.0.1:8080", Weight: 1},
		},
	})
	if err != nil {
		panic(err)
	}

	key := FiveTuple{
		SrcAddr:  netip.MustParseAddr("192.0.2.10"),
		SrcPort:  40000,
		DstAddr:  netip.MustParseAddr("198.51.100.20"),
		DstPort:  443,
		Protocol: 6,
	}

	first, err := tbl.Open(key)
	if err != nil {
		panic(err)
	}
	fmt.Printf("backend=%s active=%t\n", first.Backend.ID, first.IsActive())

	if _, err := tbl.Open(key); errors.Is(err, ErrFlowActive) {
		fmt.Println("active five-tuple collision rejected")
	}

	if _, err := tbl.Close(key, first.Generation); err != nil {
		panic(err)
	}
	second, err := tbl.Open(key)
	if err != nil {
		panic(err)
	}
	fmt.Printf("reopened generation advanced=%t\n", second.Generation > first.Generation)

	_, err = tbl.Close(key, first.Generation)
	fmt.Printf("stale release rejected=%t\n", errors.Is(err, ErrStaleGeneration))

	// Output:
	// backend=api-1 active=true
	// active five-tuple collision rejected
	// reopened generation advanced=true
	// stale release rejected=true
}
