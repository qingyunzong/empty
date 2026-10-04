// Package serialframe 实现串口帧的流式解析。
//
// 帧格式（大端）：
//
//	| magic(2) | length(2) | seq(1) | payload(length) | crc16(2) |
//
// magic 固定为 0xAA 0x55；length 为载荷字节数；crc16 为 CRC-16/CCITT-FALSE，
// 覆盖 length、seq 与 payload。解析器满足：
//   - CRC 校验失败时，从该魔数后一个字节起重新搜索（魔数可能出现在载荷中）；
//   - length 超过上限时不分配大缓冲，直接从魔数后一字节重搜；
//   - 内部缓冲大小有上界，与输入流速无关。
package serialframe

// Magic 为帧头魔数。
var Magic = [2]byte{0xAA, 0x55}

const (
	// HeaderLen = magic(2) + length(2) + seq(1)。
	HeaderLen = 5
	// CRCLen 为帧尾 CRC 字节数。
	CRCLen = 2
	// DefaultMaxPayload 为默认最大载荷字节数。
	DefaultMaxPayload = 1024
)

// Frame 为一帧解析结果。
type Frame struct {
	Seq     uint8
	Payload []byte
}

// ccittTable 为 CRC-16/CCITT-FALSE（多项式 0x1021，初值 0xFFFF）查表。
var ccittTable [256]uint16

func init() {
	for i := 0; i < 256; i++ {
		c := uint16(i) << 8
		for j := 0; j < 8; j++ {
			if c&0x8000 != 0 {
				c = c<<1 ^ 0x1021
			} else {
				c <<= 1
			}
		}
		ccittTable[i] = c
	}
}

func crc16Update(c uint16, b []byte) uint16 {
	for _, x := range b {
		c = c<<8 ^ ccittTable[byte(c>>8)^x]
	}
	return c
}

// crc 计算 length(2B BE) || seq || payload 的 CRC-16/CCITT-FALSE。
func crc(length uint16, seq uint8, payload []byte) uint16 {
	var hdr [3]byte
	hdr[0] = byte(length >> 8)
	hdr[1] = byte(length)
	hdr[2] = seq
	c := crc16Update(0xFFFF, hdr[:])
	return crc16Update(c, payload)
}

// Encode 构造一帧，主要用于测试与对端发送。
func Encode(seq uint8, payload []byte) []byte {
	n := len(payload)
	out := make([]byte, 0, HeaderLen+n+CRCLen)
	out = append(out, Magic[0], Magic[1], byte(n>>8), byte(n), seq)
	out = append(out, payload...)
	c := crc(uint16(n), seq, payload)
	return append(out, byte(c>>8), byte(c))
}
