package hpack

import "errors"

// HeaderField is one decoded header name/value pair.
type HeaderField struct {
	Name  string
	Value string
}

// StaticTable is the caller-provided HPACK static table, ordered by the
// 1-based RFC index (the slice element at index 0 is static table entry 1).
type StaticTable []HeaderField

// Len reports the number of static entries.
func (s StaticTable) Len() int { return len(s) }

// HuffmanCode describes one Huffman symbol: the N most-significant bits of
// Bits hold the code in right-aligned form (positions N and above are zero),
// transmitted most-significant bit first as in RFC 7541 appendix B. A zero N
// means the symbol has no assignment.
type HuffmanCode struct {
	Bits uint32
	N    uint8
}

// HuffmanTable is the caller-provided byte Huffman table. Codes covers the
// 256 byte symbols and EOS is the end-of-stream symbol (RFC symbol 256).
type HuffmanTable struct {
	Codes [256]HuffmanCode
	EOS   HuffmanCode
}

// ErrCompression is the root marker for every failure that destroys the
// compression context. Use errors.Is to match it.
var ErrCompression = errors.New("hpack: compression error")

// ErrInvalidTable reports a caller-supplied table that cannot be used.
var ErrInvalidTable = errors.New("hpack: invalid caller-supplied table")

// ErrNotInBlock is returned when Write or EndHeaderBlock is called without an
// active header block. It is a usage error, not a compression error.
var ErrNotInBlock = errors.New("hpack: no active header block")

// ErrInBlock is returned when BeginHeaderBlock or SetMaxDynamicTableSize is
// called while a header block is still open. It is a usage error.
var ErrInBlock = errors.New("hpack: header block already in progress")

// ErrIncomplete marks a header block that ended with a truncated
// representation. It poisons the decoder like any compression error.
var ErrIncomplete = errors.New("hpack: truncated header block")

// CompressionError wraps the concrete cause of a compression failure. Every
// CompressionError matches ErrCompression through errors.Is.
type CompressionError struct {
	Op  string
	Err error
}

func (e *CompressionError) Error() string {
	if e.Op == "" {
		return e.Err.Error()
	}
	return "hpack: " + e.Op + ": " + e.Err.Error()
}

func (e *CompressionError) Unwrap() error { return e.Err }

func (e *CompressionError) Is(target error) bool {
	return target == ErrCompression || errors.Is(e.Err, target)
}

// dynamicEntry is one dynamic table row. Entries are stored newest-first, so
// dyn[0] is the entry immediately after the static table in HPACK index space.
type dynamicEntry struct {
	name  string
	value string
	size  int
}

// Decoder is a stateful, single-connection HPACK decoder.
//
// A Decoder is not safe for concurrent use: an HTTP/2 connection serializes
// header block handling anyway.
type Decoder struct {
	static StaticTable
	huff   *huffTrie

	// dyn holds the dynamic table newest-first.
	dyn []dynamicEntry
	// size is the sum of entry sizes, cap is the current table capacity and
	// maxCap is the protocol-advertised upper bound (cap <= maxCap).
	size   int
	cap    int
	maxCap int

	// Streaming input state. buf holds unconsumed bytes, off the position of
	// the next representation inside buf.
	buf []byte
	off int

	// Fields decoded from the block currently being parsed. They are only
	// returned once the whole block is valid.
	emitted []HeaderField

	inBlock bool
	// leading is true while only dynamic table size updates have been seen at
	// the start of the current header block.
	leading bool

	failed bool
	err    error
}

// NewDecoder constructs a Decoder. static is the caller-owned static table,
// huff the caller-owned Huffman table and maxDynamicTableSize the initial
// dynamic table capacity (RFC 7541 default is 4096).
func NewDecoder(static StaticTable, huff *HuffmanTable, maxDynamicTableSize int) (*Decoder, error) {
	if len(static) == 0 {
		return nil, &CompressionError{Op: "NewDecoder", Err: ErrInvalidTable}
	}
	if maxDynamicTableSize < 0 {
		return nil, &CompressionError{Op: "NewDecoder", Err: ErrInvalidTable}
	}
	trie, err := buildHuffTrie(huff)
	if err != nil {
		return nil, &CompressionError{Op: "NewDecoder", Err: err}
	}
	return &Decoder{
		static: static,
		huff:   trie,
		cap:    maxDynamicTableSize,
		maxCap: maxDynamicTableSize,
	}, nil
}

// Failed reports whether the compression context has been permanently
// invalidated.
func (d *Decoder) Failed() bool { return d.failed }

// Err returns the permanent compression error, or nil when the Decoder is
// still usable.
func (d *Decoder) Err() error { return d.err }

// BeginHeaderBlock opens a new header block on the connection.
func (d *Decoder) BeginHeaderBlock() error {
	if d.failed {
		return d.err
	}
	if d.inBlock {
		return ErrInBlock
	}
	d.inBlock = true
	d.leading = true
	d.emitted = d.emitted[:0]
	d.buf = d.buf[:0]
	d.off = 0
	return nil
}

// EndHeaderBlock closes the current header block and returns its fields. It
// fails (and poisons the Decoder) when bytes of a truncated representation
// remain. The returned slice is owned by the caller.
func (d *Decoder) EndHeaderBlock() ([]HeaderField, error) {
	if d.failed {
		return nil, d.err
	}
	if !d.inBlock {
		return nil, ErrNotInBlock
	}
	d.inBlock = false
	if d.off < len(d.buf) {
		d.fail(&CompressionError{Op: "EndHeaderBlock", Err: ErrIncomplete})
		return nil, d.err
	}
	out := d.emitted
	d.emitted = nil
	d.buf = d.buf[:0]
	d.off = 0
	return out, nil
}

// SetMaxDynamicTableSize applies a new connection-advertised dynamic table
// size limit outside of a header block, evicting entries that no longer fit.
func (d *Decoder) SetMaxDynamicTableSize(size int) error {
	if d.failed {
		return d.err
	}
	if size < 0 {
		return &CompressionError{Op: "SetMaxDynamicTableSize", Err: ErrInvalidTable}
	}
	if d.inBlock {
		return ErrInBlock
	}
	d.maxCap = size
	if d.cap > size {
		d.cap = size
	}
	d.evictToFit()
	return nil
}

func (d *Decoder) fail(err error) {
	if d.failed {
		return
	}
	d.failed = true
	d.err = err
	d.inBlock = false
	d.dyn = nil
	d.size = 0
	d.emitted = nil
	d.buf = d.buf[:0]
	d.off = 0
}
