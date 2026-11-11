package hpack

// encoder is an independent HPACK byte producer used only by the tests. It
// encodes with the caller-supplied RFC tables and shares no code paths with
// the Decoder under test.
type encoder struct {
	static StaticTable
	huff   *HuffmanTable
}

func newEncoder() *encoder {
	return &encoder{static: rfcStaticTable(), huff: rfcHuffmanTable()}
}

// encodeInt emits an RFC 7541 section 5.1 prefix integer.
func encodeInt(b []byte, prefix byte, n uint, value int) []byte {
	mask := byte((1 << n) - 1)
	if value < int(mask) {
		return append(b, prefix|byte(value))
	}
	b = append(b, prefix|mask)
	value -= int(mask)
	for value >= 128 {
		b = append(b, byte(value%128)+128)
		value /= 128
	}
	return append(b, byte(value))
}

// encodeString emits a literal string, Huffman-encoded when huffman is set.
func (e *encoder) encodeString(b []byte, s string, huffman bool) []byte {
	if !huffman {
		b = encodeInt(b, 0, 7, len(s))
		return append(b, s...)
	}
	enc := e.huffmanEncode([]byte(s))
	b = encodeInt(b, 0x80, 7, len(enc))
	return append(b, enc...)
}

// huffmanEncode mirrors the reference packing: symbol codes are concatenated
// in a bit buffer and whole bytes are emitted big-endian. The final partial
// byte is padded with the leading all-1 bits of EOS (at most seven bits).
func (e *encoder) huffmanEncode(src []byte) []byte {
	var out []byte
	var x uint64
	var n uint
	for _, sym := range src {
		code := e.huff.Codes[sym]
		n += uint(code.N)
		x <<= code.N
		x |= uint64(code.Bits)
		for n >= 8 {
			n -= 8
			out = append(out, byte(x>>n))
			x &= 1<<n - 1
		}
	}
	if n > 0 {
		const eosNBits = 30
		pad := 8 - n
		// Leading EOS bits, right-aligned into the low pad positions.
		padBits := uint64(eosSymbolValue) >> (eosNBits - pad)
		x = x<<pad | padBits
		out = append(out, byte(x))
	}
	return out
}

const eosSymbolValue = 0x3fffffff

// indexed emits 1xxxxxxx for an existing static/dynamic entry.
func (e *encoder) indexed(idx int) []byte {
	return encodeInt(nil, 0x80, 7, idx)
}

// literal emits one of the three literal forms. form is 0x40 for incremental
// indexing, 0x00 for without indexing and 0x10 for never indexed.
func (e *encoder) literal(prefix byte, n uint, idx int, name, value string, huffman bool) []byte {
	b := encodeInt(nil, prefix, n, idx)
	if idx == 0 {
		b = e.encodeString(b, name, huffman)
	}
	b = e.encodeString(b, value, huffman)
	return b
}

// tableSizeUpdate emits 001xxxxx.
func tableSizeUpdate(size int) []byte {
	return encodeInt(nil, 0x20, 5, size)
}
