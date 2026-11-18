package formal

import "errors"

// TxID 是全局唯一的事务标识。
type TxID string

// ID 是协调者或参与者的节点标识。
type ID string

// Vote 是准备阶段参与者返回的投票。
type Vote uint8

const (
	// VoteNo 表示参与者无法进入可提交状态，协调者据此决议中止。
	VoteNo Vote = iota
	// VoteYes 表示参与者已持久化准备记录并进入「存疑」状态，
	// 此后在收到决议前不得自行提交或中止。
	VoteYes
)

// Outcome 是事务的最终决议。
type Outcome uint8

const (
	// OutcomeUnknown 表示尚未到达决策点（仅可能出现在存疑查询中）。
	OutcomeUnknown Outcome = iota
	// OutcomeCommitted 表示事务已提交。
	OutcomeCommitted
	// OutcomeAborted 表示事务已中止（含预设中止推定下的未决中止）。
	OutcomeAborted
)

// String 返回决议的可读名称。
func (o Outcome) String() string {
	switch o {
	case OutcomeCommitted:
		return "committed"
	case OutcomeAborted:
		return "aborted"
	default:
		return "unknown"
	}
}

var (
	// ErrNoVote 表示准备阶段在有限次重试后仍未拿到全部有效赞成票。
	ErrNoVote = errors.New("formal: prepare phase could not collect all yes votes")
	// ErrPendingAcks 表示提交决议已持久化，但部分参与者应答在重试预算内未到齐。
	// 决议仍然是提交；恢复流程或参与者存疑解析会继续把决议送达。
	ErrPendingAcks = errors.New("formal: commit decision durable but some acknowledgements pending")
	// ErrNotPrepared 表示对一个从未进入准备状态的事务下达了决议指令。
	ErrNotPrepared = errors.New("formal: participant has no prepared state for transaction")
	// ErrConflict 表示决议与参与者已持久化的状态冲突（例如要求提交却已中止）。
	ErrConflict = errors.New("formal: decision conflicts with participant state")
)
