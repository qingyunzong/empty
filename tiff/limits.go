package tiff

// Limits bounds the resources a single Reader is allowed to use while parsing
// and decoding. Zero values in a Limits passed to NewReaderWithLimits are
// replaced with the corresponding DefaultLimits value.
type Limits struct {
	// MaxMetadataBytes bounds the total byte size of all IFD tag values,
	// including inline and externally stored arrays of every parsed IFD.
	MaxMetadataBytes int
	// MaxIFDEntries bounds the total number of 12-byte directory entries over
	// the whole IFD chain of a Reader.
	MaxIFDEntries int
	// MaxStripDecodedBytes bounds the decoded size of a single strip.
	MaxStripDecodedBytes int
	// MaxOutputPixels bounds the number of output samples returned by one
	// ReadRect call (rectangle pixels multiplied by requested bands).
	MaxOutputPixels int
}

// DefaultLimits are the resource limits used by Open and NewReader.
var DefaultLimits = Limits{
	MaxMetadataBytes:     1 << 20,
	MaxIFDEntries:        1 << 16,
	MaxStripDecodedBytes: 256 << 20,
	MaxOutputPixels:      256 << 20,
}

func (l Limits) orDefault() Limits {
	out := DefaultLimits
	if l.MaxMetadataBytes > 0 {
		out.MaxMetadataBytes = l.MaxMetadataBytes
	}
	if l.MaxIFDEntries > 0 {
		out.MaxIFDEntries = l.MaxIFDEntries
	}
	if l.MaxStripDecodedBytes > 0 {
		out.MaxStripDecodedBytes = l.MaxStripDecodedBytes
	}
	if l.MaxOutputPixels > 0 {
		out.MaxOutputPixels = l.MaxOutputPixels
	}
	return out
}
