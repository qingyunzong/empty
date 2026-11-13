package dataeng

// EventKind 标识来自某个分片的事件类型。
type EventKind int

const (
	// EventBegin 标记事务在某个分片上开始，可携带事务声明的分片集合。
	EventBegin EventKind = iota + 1
	// EventRow 是分片内的一条行变更，按 Pos 去重。
	EventRow
	// EventCommit 标记事务在某个分片上提交，携带全局提交序号。
	EventCommit
)

func (k EventKind) String() string {
	switch k {
	case EventBegin:
		return "begin"
	case EventRow:
		return "row"
	case EventCommit:
		return "commit"
	default:
		return "unknown"
	}
}

// Event 是来自单个分片的一条 CDC 事件。
//
// 约定：
//   - Shard 为事件来源分片标识；TxnID 为全局事务标识。
//   - Pos 为事件在分片日志内的位置（单调递增），用于重启重放时去重。
//   - Begin 事件可通过 Shards 声明本事务将会涉及的全部分片；
//     Commit 事件也可携带 Shards，两处声明必须一致，否则事务被隔离。
//   - Commit 事件必须携带全局提交序号 GlobalSeq（稠密、从 1 开始），
//     同事务所有分片的 Commit 必须携带相同的 GlobalSeq。
type Event struct {
	Shard     string
	TxnID     string
	Kind      EventKind
	Pos       uint64
	GlobalSeq uint64
	Shards    []string
	Row       Row
}

// Row 是一条行变更内容。Pos 由所属 Event 提供。
type Row struct {
	Op    string // insert / update / delete，由上游定义
	Key   string
	Value []byte
}

func (r Row) equal(other Row) bool {
	if r.Op != other.Op || r.Key != other.Key {
		return false
	}
	if len(r.Value) != len(other.Value) {
		return false
	}
	for i := range r.Value {
		if r.Value[i] != other.Value[i] {
			return false
		}
	}
	return true
}

// PublishedRow 是发布时带分片与位置信息的行变更。
type PublishedRow struct {
	Shard string
	Pos   uint64
	Op    string
	Key   string
	Value []byte
}

// PublishedTxn 是一个已完整、按全局提交序发布的事务。
type PublishedTxn struct {
	TxnID     string
	GlobalSeq uint64
	// Rows 按 (Shard, Pos) 字典序排列，保证重放结果确定。
	Rows []PublishedRow
}

// Batch 是一次水位推进所越过的一组完整事务。
// 同一输入事件序列重放必然产生相同的批次序列。
type Batch struct {
	// Watermark 是本批次发布后的水位（批次内最大 GlobalSeq）。
	Watermark uint64
	// Txns 按 GlobalSeq 升序排列。
	Txns []PublishedTxn
}
