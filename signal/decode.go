package signal

import (
	"fmt"
	"math/big"
)

// Decode interprets one frame and returns every signal activated by the
// frame's selectors. Inactive signals and garbage bits outside active segments
// are never read.
func (c *CompiledPattern) Decode(frame []byte) (*DecodedFrame, error) {
	if len(frame) != c.Length {
		return nil, fmt.Errorf("%w: frame %d got %d bytes, want %d",
			ErrFrameLength, c.FrameID, len(frame), c.Length)
	}

	raw := make(map[*compiledSignal]*big.Int, len(c.signals))
	sources := make(map[*compiledSignal][]BitSource, len(c.signals))
	for _, cs := range c.signals {
		value, src := readBits(frame, cs)
		raw[cs] = value
		sources[cs] = src
	}

	active := make([]*compiledSignal, 0, len(c.signals))
	for _, cs := range c.signals {
		if c.isActive(cs, raw) {
			active = append(active, cs)
		}
	}

	if err := checkActiveOverlap(active); err != nil {
		return nil, err
	}

	decoded := &DecodedFrame{
		FrameID: c.FrameID,
		Signals: make([]DecodedSignal, 0, len(active)),
	}
	for _, cs := range active {
		value := new(big.Rat).SetInt(raw[cs])
		value.Mul(value, cs.scale)
		value.Add(value, cs.offset)

		decoded.Signals = append(decoded.Signals, DecodedSignal{
			Name:     cs.signal.Name,
			Raw:      new(big.Int).Set(raw[cs]),
			Value:    value,
			Selector: cs.signal.Selector,
			Sources:  sources[cs],
		})
	}
	return decoded, nil
}

// isActive reports whether a signal is selected in this frame. Unconditional
// signals are always active; gated signals require the selector's raw integer
// to equal the configured value.
func (c *CompiledPattern) isActive(cs *compiledSignal, raw map[*compiledSignal]*big.Int) bool {
	if cs.selector == nil {
		return true
	}
	return raw[cs.selector].Cmp(cs.equals) == 0
}

// readBits assembles the signal integer from its ordered bit positions and
// records the frame origin of every assembled bit.
func readBits(frame []byte, cs *compiledSignal) (*big.Int, []BitSource) {
	value := new(big.Int)
	src := make([]BitSource, 0, len(cs.positions))
	for assembled, pos := range cs.positions {
		byteIndex, bitInByte := pos/8, uint(pos%8)
		if frame[byteIndex]&(1<<bitInByte) != 0 {
			value.SetBit(value, assembled, 1)
		}
		src = append(src, BitSource{
			AssembledBit: uint(assembled),
			ByteIndex:    byteIndex,
			BitInByte:    bitInByte,
		})
	}

	if cs.signal.Signed && value.Bit(len(cs.positions)-1) == 1 {
		twoPowN := new(big.Int).Lsh(big.NewInt(1), uint(len(cs.positions)))
		value.Sub(value, twoPowN)
	}
	return value, src
}

// checkActiveOverlap is the runtime counterpart of the static overlap check:
// it guarantees no two activated signals share a bit even if a compiled
// pattern was tampered with.
func checkActiveOverlap(active []*compiledSignal) error {
	seen := make(map[int]*compiledSignal)
	for _, cs := range active {
		for _, pos := range cs.positions {
			if owner, exists := seen[pos]; exists {
				return fmt.Errorf("%w: signals %q and %q both use bit %d",
					ErrOverlap, owner.signal.Name, cs.signal.Name, pos)
			}
			seen[pos] = cs
		}
	}
	return nil
}
