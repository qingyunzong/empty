package dataeng

import (
	"encoding/binary"
	"fmt"
)

// headerLen 是代码、标识、长度与鉴别码的总字节数。
const headerLen = 20

// vendorSpecificType 是携带厂商子属性的属性类型。
const vendorSpecificType = 26

// minAttributeLen 是属性（类型+长度+至少1字节值）的最小长度。
const minAttributeLen = 3

// minVendorAttributeLen 是类型26属性的最小长度：类型、长度、4字节厂商号与至少1字节子属性区。
const minVendorAttributeLen = 7

// validCodes 是计费采集接受的包代码。
var validCodes = map[byte]bool{1: true, 2: true, 4: true, 5: true}

// Packet 是一个解析完成的计费包。
type Packet struct {
	Code          byte
	Identifier    byte
	Authenticator [16]byte
	Attributes    []Attribute
}

// Attribute 是一个顶层属性。类型26以外的属性只填 Value；
// 类型26填 VendorID 与 Sub。
type Attribute struct {
	Type     byte
	Value    []byte
	VendorID uint32
	Sub      []SubAttribute
}

// SubAttribute 是类型26属性值里厂商号之后的子属性。
type SubAttribute struct {
	Type  byte
	Value []byte
}

// Collector 以流式方式重组并解析计费包。解析出的包通过回调交付；
// 任一失败都会停止组件，之后 Push 与 Finish 都返回该错误，
// 已交付的包不受影响。
type Collector struct {
	maxPacket int
	deliver   func(Packet)
	buf       []byte
	err       error
}

// NewCollector 返回一个 Collector。maxPacket 是宿主允许的最大包长；
// 声明长度超过它时，在长度两字节可读后立即拒绝，不按声明长度分配。
// deliver 每解析出一个完整包调用一次。
func NewCollector(maxPacket int, deliver func(Packet)) *Collector {
	if maxPacket < headerLen {
		maxPacket = headerLen
	}
	return &Collector{maxPacket: maxPacket, deliver: deliver}
}

// Push 送入一段字节流，可以停在包的任意位置，包括属性中间。
func (c *Collector) Push(p []byte) error {
	if c.err != nil {
		return c.err
	}
	c.buf = append(c.buf, p...)
	for {
		if len(c.buf) < 4 {
			return nil
		}
		declared := int(binary.BigEndian.Uint16(c.buf[2:4]))
		if declared < headerLen {
			return c.fail(fmt.Errorf("dataeng: packet length %d is below %d-byte header", declared, headerLen))
		}
		if declared > c.maxPacket {
			return c.fail(fmt.Errorf("dataeng: packet length %d exceeds maxPacket %d", declared, c.maxPacket))
		}
		if len(c.buf) < declared {
			return nil
		}
		pkt, err := parsePacket(c.buf[:declared])
		if err != nil {
			return c.fail(err)
		}
		c.buf = c.buf[declared:]
		if c.deliver != nil {
			c.deliver(pkt)
		}
	}
}

// Finish 结束输入。仍有未完成的包时失败。
func (c *Collector) Finish() error {
	if c.err != nil {
		return c.err
	}
	if len(c.buf) != 0 {
		return c.fail(fmt.Errorf("dataeng: %d buffered bytes form an incomplete packet", len(c.buf)))
	}
	return nil
}

func (c *Collector) fail(err error) error {
	c.err = err
	return err
}

// parsePacket 解析一个长度已确认的完整包。raw 恰好是声明长度。
func parsePacket(raw []byte) (Packet, error) {
	var pkt Packet
	if !validCodes[raw[0]] {
		return pkt, fmt.Errorf("dataeng: unsupported packet code %d", raw[0])
	}
	pkt.Code = raw[0]
	pkt.Identifier = raw[1]
	copy(pkt.Authenticator[:], raw[4:headerLen])

	rest := raw[headerLen:]
	for len(rest) > 0 {
		if len(rest) < 2 {
			return pkt, fmt.Errorf("dataeng: %d trailing bytes cannot hold an attribute header", len(rest))
		}
		attrType := rest[0]
		attrLen := int(rest[1])
		if attrLen < minAttributeLen {
			return pkt, fmt.Errorf("dataeng: attribute type %d has length %d below %d", attrType, attrLen, minAttributeLen)
		}
		if attrLen > len(rest) {
			return pkt, fmt.Errorf("dataeng: attribute type %d length %d exceeds %d remaining bytes", attrType, attrLen, len(rest))
		}
		attr, err := parseAttribute(attrType, attrLen, rest[2:attrLen])
		if err != nil {
			return pkt, err
		}
		pkt.Attributes = append(pkt.Attributes, attr)
		rest = rest[attrLen:]
	}
	return pkt, nil
}

// parseAttribute 解析单个属性。value 是长度字节之后的部分。
func parseAttribute(attrType byte, attrLen int, value []byte) (Attribute, error) {
	attr := Attribute{Type: attrType}
	if attrType != vendorSpecificType {
		attr.Value = append([]byte(nil), value...)
		return attr, nil
	}
	if attrLen < minVendorAttributeLen {
		return attr, fmt.Errorf("dataeng: vendor-specific attribute length %d is below %d", attrLen, minVendorAttributeLen)
	}
	attr.VendorID = binary.BigEndian.Uint32(value[:4])
	rest := value[4:]
	for len(rest) > 0 {
		if len(rest) < 2 {
			return attr, fmt.Errorf("dataeng: %d trailing bytes cannot hold a sub-attribute header", len(rest))
		}
		subType := rest[0]
		subLen := int(rest[1])
		if subLen < minAttributeLen {
			return attr, fmt.Errorf("dataeng: sub-attribute type %d has length %d below %d", subType, subLen, minAttributeLen)
		}
		if subLen > len(rest) {
			return attr, fmt.Errorf("dataeng: sub-attribute type %d length %d overruns %d vendor value bytes", subType, subLen, len(rest))
		}
		attr.Sub = append(attr.Sub, SubAttribute{
			Type:  subType,
			Value: append([]byte(nil), rest[2:subLen]...),
		})
		rest = rest[subLen:]
	}
	return attr, nil
}
