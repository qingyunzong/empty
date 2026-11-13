package dataeng

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
)

// Writer 按采集库约定的二进制格式依次写入归档成员。
//
// 归档布局为：固定标识头 "ARCV1\n"，随后每条成员记录依次为
// uint32 大端名称长度、名称字节、uint64 大端声明字节数、
// 32 字节 SHA-256 摘要以及正文；名称长度为 0 的记录作为结束标记。
type Writer struct {
	w        io.Writer
	finished bool
}

// NewWriter 写入归档标识头并返回一个新的 Writer。
func NewWriter(w io.Writer) (*Writer, error) {
	if _, err := io.WriteString(w, archiveMagic); err != nil {
		return nil, err
	}
	return &Writer{w: w}, nil
}

// WriteMember 写入一条成员记录，摘要由正文实时计算，声明字节数即正文长度。
func (aw *Writer) WriteMember(name string, data []byte) error {
	if aw.finished {
		return errors.New("dataeng: 归档已写入结束标记，不能再追加成员")
	}
	if len(name) > maxNameLength {
		return errors.New("dataeng: 成员名称过长")
	}
	digest := sha256.Sum256(data)
	return aw.WriteMemberWithDigest(name, int64(len(data)), digest, data)
}

// WriteMemberWithDigest 写入一条显式给出声明字节数与摘要的成员记录，
// 主要用于构造摘要不符、字节数不符等异常归档进行验收测试。
func (aw *Writer) WriteMemberWithDigest(name string, declaredSize int64, digest [sha256.Size]byte, data []byte) error {
	if aw.finished {
		return errors.New("dataeng: 归档已写入结束标记，不能再追加成员")
	}
	if declaredSize < 0 {
		return errors.New("dataeng: 声明字节数不能为负")
	}

	var nameLenBuf [4]byte
	binary.BigEndian.PutUint32(nameLenBuf[:], uint32(len(name)))
	if _, err := aw.w.Write(nameLenBuf[:]); err != nil {
		return err
	}
	if _, err := io.WriteString(aw.w, name); err != nil {
		return err
	}

	var sizeBuf [8]byte
	binary.BigEndian.PutUint64(sizeBuf[:], uint64(declaredSize))
	if _, err := aw.w.Write(sizeBuf[:]); err != nil {
		return err
	}
	if _, err := aw.w.Write(digest[:]); err != nil {
		return err
	}
	if len(data) > 0 {
		if _, err := aw.w.Write(data); err != nil {
			return err
		}
	}
	return nil
}

// Close 写入名称长度为 0 的结束标记，标记归档完整结束。
func (aw *Writer) Close() error {
	if aw.finished {
		return nil
	}
	aw.finished = true
	var end [4]byte
	_, err := aw.w.Write(end[:])
	return err
}
