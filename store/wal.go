package store

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
)

// 提交帧布局(全部小端):
//
//	magic   uint32
//	version uint64
//	length  uint32  payload 长度
//	payload []byte
//	crc32   uint32  覆盖 magic..payload
//
// 恢复重放时只接受完整且 CRC 校验通过的帧;
// 遇到截断或损坏的帧即停止,其后的字节一律忽略。
const (
	frameMagic   uint32 = 0xC0FFEE01
	frameHdrSize        = 4 + 8 + 4 // magic + version + length
	frameCrcSize        = 4
	maxPayload          = 1 << 26 // 64MiB 防御性上限
)

var (
	ErrShortWrite = errors.New("store: short write to WAL")
	ErrCorrupt    = errors.New("store: corrupt WAL frame")
)

// wal 是只追加的预写日志。writeFn/syncFn 为故障注入点,
// 默认委托到底层文件,测试可替换以模拟短写与崩溃。
type wal struct {
	f      *os.File
	offset int64 // 下一个帧的写入位置(只含完整帧)

	writeFn func(p []byte) (int, error)
	syncFn  func() error
}

func openWAL(path string) (*wal, uint64, []byte, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, 0, nil, err
	}
	w := &wal{f: f}
	w.writeFn = f.Write
	w.syncFn = f.Sync

	version, value, end, err := replay(f)
	if err != nil {
		f.Close()
		return nil, 0, nil, err
	}
	// 截掉崩溃可能留下的撕裂尾部,保证日志只含完整提交帧。
	if err := f.Truncate(end); err != nil {
		f.Close()
		return nil, 0, nil, err
	}
	if _, err := f.Seek(end, io.SeekStart); err != nil {
		f.Close()
		return nil, 0, nil, err
	}
	w.offset = end
	return w, version, value, nil
}

// replay 顺序扫描帧,返回最后一个完整帧的版本与值,以及有效日志的结束偏移。
// 截断或 CRC 不匹配的帧及其后内容被忽略,不视为错误。
func replay(f *os.File) (uint64, []byte, int64, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return 0, nil, 0, err
	}
	var (
		version uint64
		value   []byte
		offset  int64
	)
	buf := make([]byte, 0, 4096)
	for {
		hdr := make([]byte, frameHdrSize)
		n, err := io.ReadFull(f, hdr)
		if err == io.EOF && n == 0 {
			return version, value, offset, nil // 干净的帧边界
		}
		if err != nil {
			// 头部撕裂:停止重放
			return version, value, offset, nil
		}
		if binary.LittleEndian.Uint32(hdr[0:4]) != frameMagic {
			return version, value, offset, nil
		}
		ver := binary.LittleEndian.Uint64(hdr[4:12])
		length := binary.LittleEndian.Uint32(hdr[12:16])
		if length > maxPayload {
			return version, value, offset, nil
		}
		need := int(length) + frameCrcSize
		if cap(buf) < need {
			buf = make([]byte, need)
		}
		body := buf[:need]
		if _, err := io.ReadFull(f, body); err != nil {
			return version, value, offset, nil // payload/crc 撕裂
		}
		want := binary.LittleEndian.Uint32(body[length:])
		crc := crc32.NewIEEE()
		crc.Write(hdr)
		crc.Write(body[:length])
		if crc.Sum32() != want {
			return version, value, offset, nil // CRC 不匹配:忽略该帧及之后内容
		}
		frameLen := int64(frameHdrSize) + int64(need)
		offset += frameLen
		version = ver
		value = append([]byte(nil), body[:length]...)
	}
}

// append 写入并 fsync 一个提交帧。任何一步失败都会把文件截回
// 原偏移,保证日志中永远不会留下半个帧,调用方不得发布状态。
func (w *wal) append(version uint64, payload []byte) error {
	if len(payload) > maxPayload {
		return fmt.Errorf("store: payload too large: %d", len(payload))
	}
	frame := make([]byte, frameHdrSize+len(payload)+frameCrcSize)
	binary.LittleEndian.PutUint32(frame[0:4], frameMagic)
	binary.LittleEndian.PutUint64(frame[4:12], version)
	binary.LittleEndian.PutUint32(frame[12:16], uint32(len(payload)))
	copy(frame[frameHdrSize:], payload)
	crc := crc32.NewIEEE()
	crc.Write(frame[:frameHdrSize+len(payload)])
	binary.LittleEndian.PutUint32(frame[frameHdrSize+len(payload):], crc.Sum32())

	n, err := w.writeFn(frame)
	if err == nil && n != len(frame) {
		err = ErrShortWrite
	}
	if err == nil {
		err = w.syncFn()
	}
	if err != nil {
		// 回滚:截断到写入前偏移,恢复写指针。
		w.f.Truncate(w.offset)
		w.f.Seek(w.offset, io.SeekStart)
		return err
	}
	w.offset += int64(len(frame))
	return nil
}

func (w *wal) close() error { return w.f.Close() }
