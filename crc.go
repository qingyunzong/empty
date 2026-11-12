package dataeng

import (
	"hash/crc32"
	"math/bits"
)

var crc32cTable = crc32.MakeTable(crc32.Castagnoli)

const maskDelta uint32 = 0xa282ead8

// maskCRC 对 CRC32C 结果执行 rotateRight32(crc,15)+0xa282ead8（uint32 回绕）。
func maskCRC(crc uint32) uint32 {
	return bits.RotateLeft32(crc, -15) + maskDelta
}

// fragmentCRC 对“类型字节接载荷”求值并返回掩码值。
func fragmentCRC(typ FragmentType, payload []byte) uint32 {
	h := crc32.New(crc32cTable)
	h.Write([]byte{byte(typ)})
	h.Write(payload)
	return maskCRC(h.Sum32())
}
