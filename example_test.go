package dataeng_test

import (
	"fmt"
	"log"

	dataeng "example.org/dataeng/q0321"
)

func ExampleDecoder() {
	// CLEAR, 'A', 'B', END, packed MSB-first at 9 bits each.
	// In a real integration the bytes come from the telemetry archive.
	codes := []uint16{256, 65, 66, 257}
	stream, err := refPack(codes, 0)
	if err != nil {
		log.Fatal(err)
	}

	dec, err := dataeng.NewDecoder(0, 1024)
	if err != nil {
		log.Fatal(err)
	}
	if err := dec.Feed(stream); err != nil {
		log.Fatal(err)
	}
	if err := dec.Finish(); err != nil {
		log.Fatal(err)
	}

	for {
		result := dec.Pull(2)
		for _, b := range result.Data {
			fmt.Printf("%c", b)
		}
		switch result.Status {
		case dataeng.StatusNeedOutput:
			continue
		case dataeng.StatusEnd:
			fmt.Println()
			return
		case dataeng.StatusFailed:
			log.Fatal(result.Err)
		default:
			log.Fatalf("unexpected status: %v", result.Status)
		}
	}
	// Output:
	// AB
}
