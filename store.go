package auditlog

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
)

// 帧格式：magic(4) | 载荷长度(4) | JSON 载荷 | CRC32(4，覆盖载荷)。
// 追加写 + fsync 保证已确认的记录持久化；打开时扫描到不完整或
// 校验失败的尾部帧即截断，从而容忍写一半断电（撕裂写）。
const (
	frameMagic   uint32 = 0x41554431 // "AUD1"
	frameHdrSize        = 8
	frameCrcSize        = 4
	maxFrameSize        = 64 << 20
)

// Store 是追加式审计记录文件。
type Store struct {
	f    *os.File
	path string
}

// OpenStore 打开（必要时创建）存储文件，并执行断电恢复：
// 从头部顺序扫描帧，将文件截断到最后一个完整且 CRC 正确的帧末尾，
// 丢弃断电造成的撕裂尾部。
func OpenStore(path string) (*Store, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	s := &Store{f: f, path: path}
	if err := s.recover(); err != nil {
		f.Close()
		return nil, err
	}
	return s, nil
}

// recover 扫描全部帧，返回最后一个完好帧的结束偏移，并截断其后的字节。
func (s *Store) recover() error {
	goodEnd, err := s.scan()
	if err != nil {
		return err
	}
	st, err := s.f.Stat()
	if err != nil {
		return err
	}
	if st.Size() > goodEnd {
		if err := s.f.Truncate(goodEnd); err != nil {
			return fmt.Errorf("auditlog: truncate torn tail: %w", err)
		}
		if err := s.f.Sync(); err != nil {
			return err
		}
	}
	_, err = s.f.Seek(0, io.SeekEnd)
	return err
}

// scan 顺序解析帧，返回最后一个完好帧之后的文件偏移。
// 遇到不完整帧、坏 magic、坏 CRC 或超长帧时停止（视为撕裂尾部）。
func (s *Store) scan() (int64, error) {
	if _, err := s.f.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	var off int64
	hdr := make([]byte, frameHdrSize)
	for {
		if _, err := io.ReadFull(s.f, hdr); err != nil {
			return off, nil // 头部不完整或干净结束
		}
		magic := binary.BigEndian.Uint32(hdr[:4])
		length := binary.BigEndian.Uint32(hdr[4:])
		if magic != frameMagic || length > maxFrameSize {
			return off, nil
		}
		body := make([]byte, length+frameCrcSize)
		if _, err := io.ReadFull(s.f, body); err != nil {
			return off, nil // 载荷不完整：断电撕裂
		}
		payload, crcBytes := body[:length], body[length:]
		if crc32.ChecksumIEEE(payload) != binary.BigEndian.Uint32(crcBytes) {
			return off, nil
		}
		off += int64(frameHdrSize) + int64(length) + frameCrcSize
	}
}

// Append 编码记录、追加一帧并 fsync，返回后记录已持久化。
func (s *Store) Append(rec *Record) error {
	payload, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	frame := make([]byte, 0, frameHdrSize+len(payload)+frameCrcSize)
	var hdr [frameHdrSize]byte
	binary.BigEndian.PutUint32(hdr[:4], frameMagic)
	binary.BigEndian.PutUint32(hdr[4:], uint32(len(payload)))
	frame = append(frame, hdr[:]...)
	frame = append(frame, payload...)
	var crc [frameCrcSize]byte
	binary.BigEndian.PutUint32(crc[:], crc32.ChecksumIEEE(payload))
	frame = append(frame, crc[:]...)
	if _, err := s.f.Write(frame); err != nil {
		return err
	}
	return s.f.Sync()
}

// Records 读取并解码全部完好记录（基于恢复后的文件内容）。
func (s *Store) Records() ([]*Record, error) {
	if _, err := s.f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	var out []*Record
	hdr := make([]byte, frameHdrSize)
	for {
		if _, err := io.ReadFull(s.f, hdr); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return out, nil
			}
			return nil, err
		}
		length := binary.BigEndian.Uint32(hdr[4:])
		body := make([]byte, length)
		if _, err := io.ReadFull(s.f, body); err != nil {
			return nil, err
		}
		var crc [frameCrcSize]byte
		if _, err := io.ReadFull(s.f, crc[:]); err != nil {
			return nil, err
		}
		rec := new(Record)
		if err := json.Unmarshal(body, rec); err != nil {
			return nil, fmt.Errorf("auditlog: decode record: %w", err)
		}
		out = append(out, rec)
	}
}

// Close 关闭底层文件。
func (s *Store) Close() error { return s.f.Close() }
