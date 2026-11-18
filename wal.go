package formal

// 顺序预写日志（write-ahead log）。
//
// 两阶段提交协议的正确性依赖于一条铁律：任何对外应答（提交/中止指令）
// 之前，对应的决策记录必须已经持久化。本文件只提供日志抽象与基于文件的
// 顺序追加实现，协议层见 coordinator.go 与 participant.go。
//
// 日志按「准备 -> 决策 -> 应答」三个阶段产生顺序记录：
//   - 准备阶段：Prepare / Vote
//   - 决策阶段：Commit / Abort
//   - 应答阶段：CommitAck / AbortAck / EndCommit / EndAbort
import (
	"bufio"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"os"
	"sync"
)

// Phase 标识一条日志记录所处的协议阶段。
type Phase uint8

const (
	PhaseUnknown   Phase = iota
	PhasePrepare         // 准备阶段
	PhaseCommit          // 决策：提交
	PhaseAbort           // 决策：中止
	PhaseCommitAck       // 应答：参与者确认提交
	PhaseAbortAck        // 应答：参与者确认中止
	PhaseEndCommit       // 应答收尾：提交决议已送达全部参与者
	PhaseEndAbort        // 应答收尾：中止决议已按预设中止推定收尾
)

// String 返回阶段的可读名称。
func (p Phase) String() string {
	switch p {
	case PhasePrepare:
		return "prepare"
	case PhaseCommit:
		return "commit"
	case PhaseAbort:
		return "abort"
	case PhaseCommitAck:
		return "commit-ack"
	case PhaseAbortAck:
		return "abort-ack"
	case PhaseEndCommit:
		return "end-commit"
	case PhaseEndAbort:
		return "end-abort"
	default:
		return "unknown"
	}
}

// Record 是 WAL 中的一条顺序记录。
type Record struct {
	Tx    TxID  // 事务标识
	Phase Phase // 协议阶段
	From  ID    // 记录来源（协调者或参与者标识）
	Data  []byte
}

// LogStore 是顺序追加日志的存储抽象。Append 必须保证记录在返回前落盘，
// 这样进程崩溃后 ReadAll 才能重放出此前所有已确认的协议事件。
type LogStore interface {
	Append(rec Record) error
	ReadAll() ([]Record, error)
	Close() error
}

// 帧布局（小端）：
//
//	magic(1) | phase(1) | lenTx(2)+tx | lenFrom(2)+from | lenData(4)+data | crc32(4)
//
// crc32 覆盖 magic 到 data 的全部字节，用于在崩溃截断时识别半条记录。
const (
	frameMagic = 0xA7
	crcLen     = 4
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// FileWAL 是基于单个文件、每次 Append 都 fsync 的顺序日志实现。
type FileWAL struct {
	mu sync.Mutex
	f  *os.File
}

// NewFileWAL 打开（不存在则创建）一个顺序日志文件。
func NewFileWAL(path string) (*FileWAL, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	return &FileWAL{f: f}, nil
}

// Append 编码、追加并强制刷盘一条记录。
func (w *FileWAL) Append(rec Record) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	body := encodeFrame(rec)
	if _, err := w.f.Write(body); err != nil {
		return err
	}
	return w.f.Sync()
}

// ReadAll 从头顺序重放全部完整帧；文件尾部因崩溃留下的截断帧会被忽略，
// 并把文件物理截断到最后一条完整帧的末尾，使后续 Append 能安全续写。
func (w *FileWAL) ReadAll() ([]Record, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if _, err := w.f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}

	r := bufio.NewReader(w.f)
	var recs []Record
	for {
		// bufio 会预读：下一帧的真实起点 = 底层文件偏移 - 缓冲中尚未消费的字节数。
		pos, err := w.f.Seek(0, io.SeekCurrent)
		if err != nil {
			return nil, err
		}
		frameStart := pos - int64(r.Buffered())
		rec, err := readFrame(r)
		if errors.Is(err, io.EOF) {
			// 干净读到 EOF：把文件偏移推进到实际末尾，保证后续 Append 不覆盖旧帧。
			if _, seekErr := w.f.Seek(0, io.SeekEnd); seekErr != nil {
				return nil, seekErr
			}
			return recs, nil
		}
		if err != nil {
			// 崩溃截断（部分帧 / CRC 失配）：日志到此为止，前面的完整帧仍然有效。
			if errors.Is(err, errTruncatedFrame) {
				// 物理截断到最后一条完整帧末尾，再把偏移移到新的文件末端。
				if truncErr := w.f.Truncate(frameStart); truncErr != nil {
					return nil, truncErr
				}
				if _, seekErr := w.f.Seek(frameStart, io.SeekStart); seekErr != nil {
					return nil, seekErr
				}
				return recs, nil
			}
			return recs, err
		}
		recs = append(recs, rec)
	}
}

// Close 关闭底层文件。
func (w *FileWAL) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.f.Close()
}

var errTruncatedFrame = errors.New("formal: truncated or corrupt wal frame")

func encodeFrame(rec Record) []byte {
	tx := []byte(rec.Tx)
	from := []byte(rec.From)

	bodyLen := 2 + len(tx) + 2 + len(from) + 4 + len(rec.Data)
	buf := make([]byte, 0, 2+bodyLen+crcLen)
	buf = append(buf, frameMagic, byte(rec.Phase))
	buf = binary.LittleEndian.AppendUint16(buf, uint16(len(tx)))
	buf = append(buf, tx...)
	buf = binary.LittleEndian.AppendUint16(buf, uint16(len(from)))
	buf = append(buf, from...)
	buf = binary.LittleEndian.AppendUint32(buf, uint32(len(rec.Data)))
	buf = append(buf, rec.Data...)

	sum := crc32.Checksum(buf, castagnoli)
	buf = binary.LittleEndian.AppendUint32(buf, sum)
	return buf
}

func readFrame(r *bufio.Reader) (Record, error) {
	magic, err := r.ReadByte()
	if err != nil {
		return Record{}, err
	}
	if magic != frameMagic {
		return Record{}, errTruncatedFrame
	}
	phaseByte, err := r.ReadByte()
	if err != nil {
		return Record{}, errTruncatedFrame
	}

	tx, err := readLenPrefixed(r, 2)
	if err != nil {
		return Record{}, errTruncatedFrame
	}
	from, err := readLenPrefixed(r, 2)
	if err != nil {
		return Record{}, errTruncatedFrame
	}
	data, err := readLenPrefixed(r, 4)
	if err != nil {
		return Record{}, errTruncatedFrame
	}
	wantSum, err := readExact(r, crcLen)
	if err != nil {
		return Record{}, errTruncatedFrame
	}

	buf := make([]byte, 0, 2+len(tx)+2+len(from)+4+len(data))
	buf = append(buf, frameMagic, phaseByte)
	buf = binary.LittleEndian.AppendUint16(buf, uint16(len(tx)))
	buf = append(buf, tx...)
	buf = binary.LittleEndian.AppendUint16(buf, uint16(len(from)))
	buf = append(buf, from...)
	buf = binary.LittleEndian.AppendUint32(buf, uint32(len(data)))
	buf = append(buf, data...)

	if binary.LittleEndian.Uint32(wantSum) != crc32.Checksum(buf, castagnoli) {
		return Record{}, errTruncatedFrame
	}
	return Record{Tx: TxID(tx), Phase: Phase(phaseByte), From: ID(from), Data: data}, nil
}

func readLenPrefixed(r *bufio.Reader, sizeLen int) ([]byte, error) {
	lenBuf, err := readExact(r, sizeLen)
	if err != nil {
		return nil, err
	}
	var n int
	switch sizeLen {
	case 2:
		n = int(binary.LittleEndian.Uint16(lenBuf))
	case 4:
		n = int(binary.LittleEndian.Uint32(lenBuf))
	}
	return readExact(r, n)
}

func readExact(r *bufio.Reader, n int) ([]byte, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// MemWAL 是进程内顺序日志，主要用于单元测试与故障注入：在指定阶段写日志时
// 触发崩溃钩子，模拟「记录未落盘就宕机」，且重启后只剩此前真正 Append 的记录。
type MemWAL struct {
	mu      sync.Mutex
	records []Record
	hook    func(Record)
	closed  bool
}

// NewMemWAL 创建带可选追加钩子的内存日志。
func NewMemWAL(hook func(Record)) *MemWAL {
	return &MemWAL{hook: hook}
}

// Append 顺序追加一条记录，并在追加成功后调用钩子。
func (m *MemWAL) Append(rec Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return errors.New("formal: mem wal closed")
	}
	m.records = append(m.records, rec)
	if m.hook != nil {
		m.hook(rec)
	}
	return nil
}

// ReadAll 返回已追加记录的副本。
func (m *MemWAL) ReadAll() ([]Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Record, len(m.records))
	copy(out, m.records)
	return out, nil
}

// Close 标记日志关闭。
func (m *MemWAL) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	return nil
}
