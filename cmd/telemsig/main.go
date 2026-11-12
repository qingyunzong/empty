// telemsig is a minimal collection-host program showing how an external
// process imports the signal package to compile a multiplexed frame pattern
// and decode hand-encoded frames.
package main

import (
	"fmt"

	"example.org/dataeng/q0181/signal"
)

func setBit(frame []byte, pos int) {
	frame[pos/8] |= 1 << uint(pos%8)
}

func setRaw(frame []byte, positions []int, value uint64) {
	for bit, pos := range positions {
		if value&(1<<bit) != 0 {
			setBit(frame, pos)
		}
	}
}

func main() {
	tempBits := []signal.Bit{
		{Index: 0, InByte: 3}, {Index: 0, InByte: 4}, {Index: 0, InByte: 5}, {Index: 0, InByte: 6},
		{Index: 0, InByte: 7}, {Index: 1, InByte: 0}, {Index: 1, InByte: 1}, {Index: 1, InByte: 2},
	}
	tempPositions := []int{3, 4, 5, 6, 7, 8, 9, 10}

	pattern := signal.Pattern{
		FrameID: 0x100,
		Length:  3,
		Signals: []signal.Signal{
			{Name: "mux", Bits: []signal.Bit{{Index: 0, InByte: 0}, {Index: 0, InByte: 1}, {Index: 0, InByte: 2}}, Scale: signal.Rational{Num: 1, Den: 1}},
			{
				Name: "temp", Bits: tempBits, Signed: true,
				Scale: signal.Rational{Num: 1, Den: 10}, Selector: "mux", Equals: 1,
			},
			{
				Name: "pressure", Bits: tempBits,
				Scale: signal.Rational{Num: 1, Den: 4}, Offset: signal.Rational{Num: 1, Den: 2},
				Selector: "mux", Equals: 2,
			},
		},
	}

	compiled, err := pattern.Compile()
	if err != nil {
		panic(err)
	}

	frame := make([]byte, 3)
	setBit(frame, 0) // mux = 1
	setRaw(frame, tempPositions, 0x80)

	decoded, err := compiled.Decode(frame)
	if err != nil {
		panic(err)
	}

	fmt.Printf("frame %#x decoded %d active signals:\n", decoded.FrameID, len(decoded.Signals))
	for _, sig := range decoded.Signals {
		fmt.Printf("- %s raw=%s value=%s sources=%d\n",
			sig.Name, sig.Raw.String(), sig.Value.RatString(), len(sig.Sources))
		for _, src := range sig.Sources {
			fmt.Printf("    bit %d <- byte %d, bit-in-byte %d\n",
				src.AssembledBit, src.ByteIndex, src.BitInByte)
		}
	}
}
