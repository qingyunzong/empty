package tiff

import "encoding/binary"

func orderFor(little bool) binary.ByteOrder {
	if little {
		return binary.LittleEndian
	}
	return binary.BigEndian
}
