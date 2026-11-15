package dataeng

import (
	"bufio"
	"errors"
	"io"
	"io/fs"
	"os"
)

// Generation 标识路径上某一任文件的生存期。
// rename-create 替换文件或 copytruncate 截断文件都会开启新世代。
type Generation uint64

// Record 是 tail 产出的一条日志记录，绑定文件世代与起始字节偏移。
type Record struct {
	Path       string
	FileID     FileID
	Generation Generation
	Offset     int64
	Data       []byte
}

// handle 是一个已打开文件的读取状态。
type handle struct {
	f      *os.File
	id     FileID
	fp     Fingerprint
	fpLen  int64 // 指纹覆盖的头部长度
	gen    Generation
	offset int64 // 已产出记录覆盖的字节数（不含残行与缓冲）
	reader *bufio.Reader
	pend   []byte // 尚未以换行结尾的残行
}

// consumed 返回下一个未读字节的偏移，用于检查点。
func (h *handle) consumed() int64 {
	return h.offset + int64(len(h.pend)) + int64(h.reader.Buffered())
}

// Tailer 跟踪单一路径的日志文件，处理 rename-create、copytruncate
// 以及轮转后仍写入旧文件的延迟写。
type Tailer struct {
	path string
	gen  Generation
	cur  *handle
	old  []*handle // 已轮转、待排空到 EOF 后关闭的旧句柄
}

func NewTailer(path string) *Tailer { return &Tailer{path: path} }

func (t *Tailer) Path() string { return t.path }

// Generation 返回当前文件世代。
func (t *Tailer) Generation() Generation { return t.gen }

func (t *Tailer) openAt(offset int64) (*handle, error) {
	f, err := os.Open(t.path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	fpLen := fingerprintLen(info.Size())
	fp, err := fingerprintOf(f, fpLen)
	if err != nil {
		f.Close()
		return nil, err
	}
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			f.Close()
			return nil, err
		}
	}
	h := &handle{f: f, id: fileIDOf(info), fp: fp, fpLen: fpLen, offset: offset}
	h.reader = bufio.NewReader(f)
	return h, nil
}

// Poll 读取自上次调用以来的新增完整行。
// 文件不存在时返回空结果，等待文件出现。
func (t *Tailer) Poll() ([]Record, error) {
	var recs []Record

	if t.cur != nil {
		info, err := os.Stat(t.path)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			// rename 后新文件尚未创建：保留旧句柄，继续吸收延迟写入。
		case err != nil:
			return recs, err
		default:
			sid := fileIDOf(info)
			if sid != t.cur.id {
				// rename-create：旧句柄转入排空队列，之后读到 EOF 关闭。
				t.old = append(t.old, t.cur)
				t.cur = nil
			} else if info.Size() < t.cur.consumed() {
				// copytruncate：同 inode 被截断，开启新世代从头读。
				t.gen++
				if _, err := t.cur.f.Seek(0, io.SeekStart); err != nil {
					return recs, err
				}
				fpLen := fingerprintLen(info.Size())
				fp, err := fingerprintOf(t.cur.f, fpLen)
				if err != nil {
					return recs, err
				}
				t.cur.fp = fp
				t.cur.fpLen = fpLen
				t.cur.gen = t.gen
				t.cur.offset = 0
				t.cur.reader.Reset(t.cur.f)
				t.cur.pend = nil
			}
		}
	}

	if t.cur == nil {
		h, err := t.openAt(0)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				return recs, err
			}
		} else {
			t.gen++
			h.gen = t.gen
			t.cur = h
		}
	}

	if t.cur != nil {
		rs, err := t.readFrom(t.cur, false)
		recs = append(recs, rs...)
		if err != nil {
			return recs, err
		}
	}

	// 排空旧句柄到 EOF（含轮转后的延迟写入），随后关闭。
	for _, h := range t.old {
		rs, err := t.readFrom(h, true)
		recs = append(recs, rs...)
		h.f.Close()
		if err != nil {
			return recs, err
		}
	}
	t.old = t.old[:0]

	return recs, nil
}

// readFrom 读取完整行；flush 为 true 时在 EOF 处把残行也产出（用于旧句柄关闭前）。
func (t *Tailer) readFrom(h *handle, flush bool) ([]Record, error) {
	var recs []Record
	for {
		line, err := h.reader.ReadBytes('\n')
		if len(line) > 0 {
			if line[len(line)-1] == '\n' {
				data := append(h.pend, line...)
				recs = append(recs, Record{
					Path:       t.path,
					FileID:     h.id,
					Generation: h.gen,
					Offset:     h.offset,
					Data:       data,
				})
				h.offset += int64(len(data))
				h.pend = nil
			} else {
				h.pend = append(h.pend, line...)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if flush && len(h.pend) > 0 {
					recs = append(recs, Record{
						Path:       t.path,
						FileID:     h.id,
						Generation: h.gen,
						Offset:     h.offset,
						Data:       h.pend,
					})
					h.offset += int64(len(h.pend))
					h.pend = nil
				}
				return recs, nil
			}
			return recs, err
		}
	}
}

// Close 关闭所有打开的句柄。
func (t *Tailer) Close() error {
	if t.cur != nil {
		t.cur.f.Close()
		t.cur = nil
	}
	for _, h := range t.old {
		h.f.Close()
	}
	t.old = nil
	return nil
}
