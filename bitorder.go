package telemcodec

// BitOrder selects how stream bits map onto bytes.
type BitOrder int

const (
	// MSBFirst fills each byte from bit 7 downward; the first stream bit of
	// a field is the field's most significant bit.
	MSBFirst BitOrder = iota
	// LSBFirst fills each byte from bit 0 upward; the first stream bit of a
	// field is the field's least significant bit.
	LSBFirst
)

func (o BitOrder) valid() bool { return o == MSBFirst || o == LSBFirst }
