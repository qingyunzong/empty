package blkarc

import "encoding/binary"

func binary_LittleEndian_Uint32(b []byte) uint32 { return binary.LittleEndian.Uint32(b) }
func binary_LittleEndian_Uint16(b []byte) uint16 { return binary.LittleEndian.Uint16(b) }
