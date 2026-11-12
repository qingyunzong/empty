package dataeng

// PayloadRange 描述单个片载荷在物理文件中的半开区间 [Start, Start+Length)。
// Length 为 0 时表示空片的载荷区间，Start 仍指向该载荷（即头之后）的物理偏移。
type PayloadRange struct {
	Start  int64
	Length int64
}

// Record 是交付给回调的一条完整逻辑记录。
//
// Payload 仅在回调执行期间有效，回调返回后可能被后续读取复用；需要保留时
// 宿主必须自行复制。LogicalStart 是首个片（FULL 或 FIRST）头条目的物理偏移；
// Ranges 按物理顺序列出组成该记录的全部片载荷区间。
type Record struct {
	Payload      []byte
	LogicalStart int64
	Ranges       []PayloadRange
}

// Checkpoint 绑定已确认逻辑记录边界处的物理位置与文件前缀 SHA256。
//
// PrefixBytes 是已读字节数；PrefixSHA256 是文件 [0, PrefixBytes) 前缀的
// SHA256 摘要。检查点只能在回调成功后获取，Resume 时会重新扫描整个前缀，
// 而不是仅信任该结构中的摘要。
type Checkpoint struct {
	PrefixBytes  int64
	PrefixSHA256 [32]byte
}

// TruncationReason 说明恢复模式下真实 EOF 尾记录为何被丢弃。
type TruncationReason int

const (
	// TruncatedHeader：EOF 处片头不完整（含不足 7 字节的全零填充之外的残头）。
	TruncatedHeader TruncationReason = iota + 1
	// TruncatedPayload：片头完整但载荷在 EOF 前不完整。
	TruncatedPayload
	// UnclosedRecord：FIRST/MIDDLE 开启的逻辑记录缺少闭合 LAST。
	UnclosedRecord
)

func (r TruncationReason) String() string {
	switch r {
	case TruncatedHeader:
		return "truncated header at EOF"
	case TruncatedPayload:
		return "truncated payload at EOF"
	case UnclosedRecord:
		return "unclosed record at EOF"
	default:
		return "unknown truncation"
	}
}

// Truncation 是恢复模式对真实 EOF 未完成尾记录的截断报告。
// 一次读取生命周期最多生成一份；记录从 LogicalStart（残头/残载荷时为该片头
// 偏移）开始、到 EOF 的 BytesDropped 字节不会被交付。
type Truncation struct {
	Reason       TruncationReason
	LogicalStart int64
	BytesDropped int64
}
