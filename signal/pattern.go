package signal

// Pattern describes the signals carried by one telemetry frame ID.
//
// Length is the fixed frame size in bytes. Bit numbering is global:
// byte index * 8 + low-numbered bit offset inside the byte.
type Pattern struct {
	FrameID uint32
	Length  int
	Signals []Signal
}
