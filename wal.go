package dataeng

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const (
	walMagic   = "DWAL"
	walVersion = byte(1)

	walKindEvent = byte(1)
	walKindSeal  = byte(2)

	walHeaderLen = 10 // magic(4) + version(1) + kind(1) + length(4)
	walCRCLen    = 4
)

type walEnvelope struct {
	Kind  string    `json:"kind"`
	Event *Event    `json:"event,omitempty"`
	At    time.Time `json:"at,omitempty"`
}

// walWriter 向当前分段顺序追加帧，并在超过阈值时滚动到下一段。
type walWriter struct {
	dir      string
	file     *os.File
	segment  int
	frames   int
	bytes    int64
	maxBytes int64
	fsync    bool
}

func openWALWriter(dir string, maxBytes int64, fsync bool) (*walWriter, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	segs, err := walSegments(dir)
	if err != nil {
		return nil, err
	}
	next := 1
	if len(segs) > 0 {
		next = segs[len(segs)-1].seq + 1
	}
	path := filepath.Join(dir, walSegmentName(next))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	off, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		f.Close()
		return nil, err
	}
	return &walWriter{
		dir: dir, file: f, segment: next, bytes: off,
		maxBytes: maxBytes, fsync: fsync,
	}, nil
}

func walSegmentName(seq int) string { return fmt.Sprintf("%08d.wal", seq) }

type walSegmentInfo struct {
	seq  int
	path string
}

func walSegments(dir string) ([]walSegmentInfo, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []walSegmentInfo
	for _, e := range entries {
		name := e.Name()
		if filepath.Ext(name) != ".wal" {
			continue
		}
		var seq int
		if _, err := fmt.Sscanf(name, "%08d.wal", &seq); err != nil {
			continue
		}
		out = append(out, walSegmentInfo{seq: seq, path: filepath.Join(dir, name)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].seq < out[j].seq })
	return out, nil
}

func (w *walWriter) append(kind byte, payload []byte) error {
	if w.maxBytes > 0 && w.bytes > 0 && w.bytes+int64(walHeaderLen+len(payload)+walCRCLen) > w.maxBytes {
		if err := w.rotate(); err != nil {
			return err
		}
	}
	frame := make([]byte, 0, walHeaderLen+len(payload)+walCRCLen)
	frame = append(frame, walMagic...)
	frame = append(frame, walVersion, kind)
	frame = binary.BigEndian.AppendUint32(frame, uint32(len(payload)))
	frame = append(frame, payload...)
	sum := crc32.ChecksumIEEE(payload)
	frame = binary.BigEndian.AppendUint32(frame, sum)

	n, err := w.file.Write(frame)
	if err != nil {
		return err
	}
	if w.fsync {
		if err := w.file.Sync(); err != nil {
			return err
		}
	}
	w.frames++
	w.bytes += int64(n)
	return nil
}

func (w *walWriter) appendEvent(ev *Event) error {
	payload, err := json.Marshal(walEnvelope{Kind: "event", Event: ev})
	if err != nil {
		return err
	}
	return w.append(walKindEvent, payload)
}

func (w *walWriter) appendSeal(at time.Time) error {
	payload, err := json.Marshal(walEnvelope{Kind: "seal", At: at})
	if err != nil {
		return err
	}
	return w.append(walKindSeal, payload)
}

func (w *walWriter) rotate() error {
	if err := w.file.Close(); err != nil {
		return err
	}
	w.segment++
	w.bytes = 0
	w.frames = 0
	path := filepath.Join(w.dir, walSegmentName(w.segment))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	w.file = f
	return nil
}

func (w *walWriter) close() error {
	if w == nil || w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

// replayWAL 按分段顺序回放帧，对每条事件/封闭帧调用回调。
// 段首遇到干净 EOF 跳过；半帧或 CRC 不匹配返回 ErrCorruptWAL。
func replayWAL(dir string, onEvent func(*Event) error, onSeal func(time.Time) error) error {
	segs, err := walSegments(dir)
	if err != nil {
		return err
	}
	for _, seg := range segs {
		if err := replayWALSegment(seg.path, onEvent, onSeal); err != nil {
			return fmt.Errorf("%w: %s: %v", ErrCorruptWAL, seg.path, err)
		}
	}
	return nil
}

// walHasSeal 预扫描分段，报告 WAL 中是否存在封闭帧。恢复流程据此决定
// 重放顺序：先以未封闭态消费封闭前事件，越过封闭帧后再切换为封闭态。
func walHasSeal(dir string) bool {
	segs, err := walSegments(dir)
	if err != nil {
		return false
	}
	found := false
	for _, seg := range segs {
		data, err := os.ReadFile(seg.path)
		if err != nil {
			return false
		}
		pos := 0
		for pos+walHeaderLen+walCRCLen <= len(data) {
			if string(data[pos:pos+4]) != walMagic {
				return found
			}
			kind := data[pos+5]
			payloadLen := int(binary.BigEndian.Uint32(data[pos+6 : pos+10]))
			end := pos + walHeaderLen + payloadLen + walCRCLen
			if end > len(data) {
				return found
			}
			if kind == walKindSeal {
				found = true
			}
			pos = end
		}
	}
	return found
}

func replayWALSegment(path string, onEvent func(*Event) error, onSeal func(time.Time) error) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	pos := 0
	for pos < len(data) {
		if len(data)-pos < walHeaderLen+walCRCLen {
			return io.ErrUnexpectedEOF
		}
		if string(data[pos:pos+4]) != walMagic {
			return fmt.Errorf("bad magic")
		}
		if data[pos+4] != walVersion {
			return fmt.Errorf("unsupported version %d", data[pos+4])
		}
		kind := data[pos+5]
		payloadLen := int(binary.BigEndian.Uint32(data[pos+6 : pos+10]))
		end := pos + walHeaderLen + payloadLen
		if end+walCRCLen > len(data) {
			return io.ErrUnexpectedEOF
		}
		payload := data[pos+walHeaderLen : end]
		gotCRC := binary.BigEndian.Uint32(data[end : end+walCRCLen])
		if crc32.ChecksumIEEE(payload) != gotCRC {
			return fmt.Errorf("crc mismatch")
		}
		var env walEnvelope
		if err := json.Unmarshal(payload, &env); err != nil {
			return err
		}
		switch kind {
		case walKindEvent:
			if env.Event == nil {
				return fmt.Errorf("event frame missing payload")
			}
			if err := onEvent(env.Event); err != nil {
				return err
			}
		case walKindSeal:
			if err := onSeal(env.At); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unknown frame kind %d", kind)
		}
		pos = end + walCRCLen
	}
	return nil
}
