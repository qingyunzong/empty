// Host-side example: feed one Steim record body one byte at a time and
// print the decoded int32 sequence with provenance.
package main

import (
	"fmt"

	"example.org/dataeng/q0295/steim"
)

func main() {
	const (
		encoding   = 1
		maxSamples = 1024
	)

	// A one-frame Steim-1 body built by a record assembler elsewhere in
	// the ingestion pipeline. N = 4 samples, L = 64 bytes.
	body := buildExampleBody()
	n := 4

	dec, err := steim.NewDecoder(encoding, n, len(body), maxSamples)
	if err != nil {
		panic(err)
	}

	// Network chunks can have any boundary; here the record arrives a
	// single byte per Push to prove boundaries are irrelevant.
	for _, b := range body {
		if err := dec.Push([]byte{b}); err != nil {
			panic(err)
		}
	}

	samples, err := dec.Finish()
	if err != nil {
		panic(err)
	}

	for index, s := range samples {
		fmt.Printf("sample[%d]=%d frame=%d word=%d diff=%d\n",
			index, s.Value, s.Frame, s.Word, s.Diff)
	}

	// A delivered or failed decoder rejects any reuse.
	if _, err := dec.Finish(); err != steim.ErrState {
		panic("expected ErrState on second Finish")
	}
}

func buildExampleBody() []byte {
	// X0 = 100; d0 = 7 (bridge, ignored); deltas 3, -5, 2 =>
	// samples 100, 103, 98, 100, so Xn = 100.
	x0 := uint32(100)
	xn := uint32(100)

	// Frame 0: j=1 and j=2 must be control 0 (integration constants).
	// j=3 packs four 8-bit differences: 7, 3, -5, 2.
	var negFive int8 = -5
	c3 := uint32(7)<<24 | uint32(3)<<16 | uint32(byte(negFive))<<8 | uint32(2)
	control := uint32(1) << (30 - 2*3) // code 1 = four 8-bit fields

	words := [16]uint32{control, x0, xn, c3}
	body := make([]byte, 64)
	for i, word := range words {
		body[4*i] = byte(word >> 24)
		body[4*i+1] = byte(word >> 16)
		body[4*i+2] = byte(word >> 8)
		body[4*i+3] = byte(word)
	}
	return body
}
