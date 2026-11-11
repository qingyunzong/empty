package hpack

import (
	"errors"
	"fmt"
)

var (
	errEOSInStream    = errors.New("EOS symbol inside Huffman-encoded string")
	errBadCode        = errors.New("invalid Huffman code")
	errBadPadding     = errors.New("Huffman padding is not a prefix of EOS")
	errPaddingTooLong = errors.New("Huffman padding longer than 7 bits")
)

// huffNode is one binary trie node. A node with symbol >= 0 is a leaf; other
// nodes are interior. The EOS code is not inserted, so it can be validated
// separately as a trailing prefix.
type huffNode struct {
	children [2]*huffNode
	symbol   int
}

// huffTrie is the decoded caller table plus its EOS metadata.
type huffTrie struct {
	root    *huffNode
	eosBits uint32
	eosN    uint8
}

// buildHuffTrie validates the caller table and turns it into a binary trie
// walked MSB-first.
func buildHuffTrie(table *HuffmanTable) (*huffTrie, error) {
	if table == nil {
		return nil, ErrInvalidTable
	}
	if table.EOS.N == 0 || table.EOS.N > 30 {
		return nil, ErrInvalidTable
	}
	trie := &huffTrie{root: &huffNode{symbol: -1}, eosBits: table.EOS.Bits, eosN: table.EOS.N}

	for symbol := 0; symbol < 256; symbol++ {
		code := table.Codes[symbol]
		if code.N == 0 {
			return nil, ErrInvalidTable
		}
		if err := trie.insert(symbol, code.Bits, code.N); err != nil {
			return nil, err
		}
	}
	return trie, nil
}

// insert places one code, rejecting lengths outside 1..30, prefix conflicts
// and duplicate leaves.
func (t *huffTrie) insert(symbol int, bits uint32, n uint8) error {
	if n == 0 || n > 30 {
		return fmt.Errorf("%w: Huffman code length out of range", ErrInvalidTable)
	}
	// Codes are right-aligned, so bits at positions n and above must be zero.
	if bits >= uint32(1)<<n {
		return fmt.Errorf("%w: Huffman code has bits above its length", ErrInvalidTable)
	}
	node := t.root
	// The table holds right-aligned codes whose bit n-1..0 order matches the
	// wire's most-significant-bit-first sequence, so decode feeds wire bits
	// straight into successive trie levels.
	for i := n; i > 0; i-- {
		bit := (bits >> (i - 1)) & 1
		next := node.children[bit]
		if next == nil {
			next = &huffNode{symbol: -1}
			node.children[bit] = next
		} else if next.symbol >= 0 {
			return fmt.Errorf("%w: Huffman code collides with an existing symbol", ErrInvalidTable)
		}
		node = next
	}
	if node.symbol >= 0 || node.children[0] != nil || node.children[1] != nil {
		return fmt.Errorf("%w: duplicate or prefix-conflicting Huffman code", ErrInvalidTable)
	}
	node.symbol = symbol
	return nil
}

// decode expands one Huffman string per RFC 7541 section 5.2. Symbols are
// decoded most-significant bit first over a binary trie. After the final
// completed symbol, the only legal remainder is a run of at most seven 1-bits
// that forms a prefix of the EOS code. The EOS symbol itself, an invalid code,
// an overlong or incomplete tail, and any non-1 padding bit are rejected.
func (t *huffTrie) decode(src []byte) ([]byte, error) {
	if len(src) == 0 {
		return []byte{}, nil
	}
	out := make([]byte, 0, len(src))
	node := t.root
	totalBits := len(src) * 8
	// lastEnd is the bit index just after the final completed symbol.
	lastEnd := 0
	// nilAt records the first bit whose trie edge is missing, or -1 when every
	// bit followed a trie path.
	nilAt := -1

	for idx := 0; idx < totalBits; idx++ {
		bit := int((src[idx/8] >> uint(7-idx%8)) & 1)
		next := node.children[bit]
		if next == nil {
			// A missing edge anywhere before the final byte cannot be padding.
			if idx/8 != len(src)-1 {
				return nil, errBadCode
			}
			nilAt = idx
			break
		}
		node = next
		if node.symbol >= 0 {
			out = append(out, byte(node.symbol))
			node = t.root
			lastEnd = idx + 1
		}
	}

	remaining := totalBits - lastEnd
	if remaining == 0 {
		if node != t.root {
			return nil, errBadCode
		}
		return out, nil
	}
	// A missing trie edge is only legal when it lies inside the all-1 trailing
	// region that begins after the last completed symbol.
	if nilAt >= 0 && nilAt < lastEnd {
		return nil, errBadCode
	}

	// Trailing region: too many bits means an incomplete symbol, an overlong
	// padding run, or the full EOS symbol.
	if remaining > 7 {
		if !t.allOnes(src, lastEnd, totalBits) {
			return nil, errBadCode
		}
		if remaining >= int(t.eosN) {
			return nil, errEOSInStream
		}
		return nil, errPaddingTooLong
	}

	// Every trailing bit must be 1 and the run must be a reachable EOS prefix.
	if !t.allOnes(src, lastEnd, totalBits) {
		return nil, errBadPadding
	}
	cursor := t.root
	for k := 0; k < remaining; k++ {
		cursor = cursor.children[1]
		if cursor == nil {
			return nil, errBadPadding
		}
	}
	return out, nil
}

// allOnes reports whether every bit in src[start:end] (MSB-first indexing) is 1.
func (t *huffTrie) allOnes(src []byte, start, end int) bool {
	for j := start; j < end; j++ {
		if (src[j/8]>>uint(7-j%8))&1 != 1 {
			return false
		}
	}
	return true
}
