package dataeng

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
)

// Checkpoint 记录恢复 tail 所需的状态。
// 恢复时以 FileID + Fingerprint 双重校验，避免把偏移套到错误的文件上。
type Checkpoint struct {
	Path        string
	FileID      FileID
	Generation  Generation
	Fingerprint Fingerprint
	Size        int64 // 指纹覆盖的文件头部长度
	Offset      int64
}

// Checkpoint 导出当前文件的读取位置；没有打开的文件时返回 false。
func (t *Tailer) Checkpoint() (Checkpoint, bool) {
	if t.cur == nil {
		return Checkpoint{}, false
	}
	return Checkpoint{
		Path:        t.path,
		FileID:      t.cur.id,
		Generation:  t.cur.gen,
		Fingerprint: t.cur.fp,
		Size:        t.cur.fpLen,
		Offset:      t.cur.consumed(),
	}, true
}

// Restore 从检查点恢复 Tailer。
// 仅当路径当前文件的 FileID 与 Fingerprint 都和检查点一致时才沿用偏移与世代；
// 否则从偏移 0 开始新世代——既不会把新文件的偏移套到旧文件，也不会反过来。
func Restore(cp Checkpoint) (*Tailer, error) {
	t := &Tailer{path: cp.Path}
	f, err := os.Open(cp.Path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return t, nil
		}
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	// 当前文件必须能覆盖检查点指纹的长度，且指纹一致，才允许沿用偏移。
	match := info.Size() >= cp.Size
	if match {
		fp, err := fingerprintOf(f, cp.Size)
		if err != nil {
			f.Close()
			return nil, err
		}
		match = fp == cp.Fingerprint
	}
	h := &handle{f: f, id: fileIDOf(info)}
	h.reader = bufio.NewReader(f)
	if match && h.id == cp.FileID {
		h.fp = cp.Fingerprint
		h.fpLen = cp.Size
		if cp.Offset > 0 {
			if _, err := h.f.Seek(cp.Offset, io.SeekStart); err != nil {
				h.f.Close()
				return nil, err
			}
			h.offset = cp.Offset
			h.reader.Reset(h.f)
		}
		h.gen = cp.Generation
		t.gen = cp.Generation
	} else {
		h.fpLen = fingerprintLen(info.Size())
		fp, err := fingerprintOf(f, h.fpLen)
		if err != nil {
			h.f.Close()
			return nil, err
		}
		h.fp = fp
		t.gen = 1
		h.gen = 1
	}
	t.cur = h
	return t, nil
}

// SaveCheckpoint 把检查点以 JSON 写入文件。
func SaveCheckpoint(path string, cp Checkpoint) error {
	data, err := json.Marshal(cp)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// LoadCheckpoint 从文件读取检查点。
func LoadCheckpoint(path string) (Checkpoint, error) {
	var cp Checkpoint
	data, err := os.ReadFile(path)
	if err != nil {
		return cp, err
	}
	return cp, json.Unmarshal(data, &cp)
}
