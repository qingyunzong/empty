package dataeng

// DefaultMaxBytes is the default host-imposed limit on the complete encoded
// data set. It exists so that a malicious or corrupt declared length cannot
// make a caller allocate or scan unbounded input.
const DefaultMaxBytes int64 = 64 << 20

// DefaultMaxDepth is the default limit on sequence/item nesting.
const DefaultMaxDepth = 64

// Options controls parsing limits and optional sequence recognition.
type Options struct {
	// MaxBytes limits the total encoded size of the data set. Values less
	// than or equal to zero select DefaultMaxBytes.
	MaxBytes int64

	// MaxDepth limits sequence and item nesting. Values less than or equal
	// to zero select DefaultMaxDepth.
	MaxDepth int

	// AllowUnorderedPrivate disables the requirement that a private data
	// element follows a private creator for its block in the same layer.
	AllowUnorderedPrivate bool

	// SequenceTags lets callers identify known-length sequences. Implicit-VR
	// streams carry no VR, so a sequence with a defined length can only be
	// recognized with dictionary knowledge. Undefined-length sequences are
	// always recognized automatically.
	SequenceTags map[Tag]bool
}

func (o Options) withDefaults() Options {
	if o.MaxBytes <= 0 {
		o.MaxBytes = DefaultMaxBytes
	}
	if o.MaxDepth <= 0 {
		o.MaxDepth = DefaultMaxDepth
	}
	return o
}

func (o Options) isSequenceTag(t Tag) bool {
	return o.SequenceTags != nil && o.SequenceTags[t]
}
