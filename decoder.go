package msglib

import (
	"encoding/binary"
	"fmt"
)

// Decoder 支持以任意大小的切块流式喂入数据，逐步解析字段。
// 声明长度超过 MaxPayload 时立即拒绝整包；Finalize 时若仍有
// 未完成的字段（截断），同样拒绝整包。
type Decoder struct {
	schema Schema
	buf    []byte
	msg    *Message
	err    error
}

// NewDecoder 创建一个按 schema 归并字段的流式解码器。
func NewDecoder(schema Schema) *Decoder {
	return &Decoder{schema: schema, msg: NewMessage()}
}

// Feed 喂入一块数据（大小任意），返回首个解析错误；出错后解码器不可用。
func (d *Decoder) Feed(chunk []byte) error {
	if d.err != nil {
		return d.err
	}
	d.buf = append(d.buf, chunk...)
	d.err = d.drain()
	return d.err
}

// drain 尽可能多地解析缓冲区中的完整字段。
func (d *Decoder) drain() error {
	for {
		if len(d.buf) < HeaderLen {
			return nil
		}
		length := binary.BigEndian.Uint32(d.buf[2:6])
		if uint64(length) > MaxPayload {
			tag := binary.BigEndian.Uint16(d.buf[0:2])
			return fmt.Errorf("%w: tag %d declares %d bytes, max is %d",
				ErrLengthOverflow, tag, length, MaxPayload)
		}
		total := HeaderLen + int(length)
		if len(d.buf) < total {
			return nil // 载荷未到齐，等待更多数据
		}
		tag := binary.BigEndian.Uint16(d.buf[0:2])
		payload := make([]byte, length)
		copy(payload, d.buf[HeaderLen:total])
		d.msg.addField(d.schema, tag, payload)
		d.buf = d.buf[total:]
	}
}

// Finalize 结束输入并返回解析结果；若存在截断的残留数据则拒绝整包。
func (d *Decoder) Finalize() (*Message, error) {
	if d.err != nil {
		return nil, d.err
	}
	if len(d.buf) != 0 {
		return nil, fmt.Errorf("%w: %d leftover bytes at end of stream", ErrTruncated, len(d.buf))
	}
	return d.msg, nil
}
