package formal

import "time"

// EventType 标识协调器生命周期中的一类状态变更。
type EventType uint8

const (
	EvExecutorRegistered EventType = iota + 1
	EvExecutorLost
	EvTaskSubmitted
	EvAttemptScheduled
	EvAttemptSucceeded
	EvAttemptFailed
	EvAttemptTimedOut
	EvAttemptCancelled
	EvPartitionCommitted
	EvResultRejected
	EvTaskFailed
	EvHoldPlaced
	EvUsageBilled
	EvHoldReleased
)

func (t EventType) String() string {
	switch t {
	case EvExecutorRegistered:
		return "ExecutorRegistered"
	case EvExecutorLost:
		return "ExecutorLost"
	case EvTaskSubmitted:
		return "TaskSubmitted"
	case EvAttemptScheduled:
		return "AttemptScheduled"
	case EvAttemptSucceeded:
		return "AttemptSucceeded"
	case EvAttemptFailed:
		return "AttemptFailed"
	case EvAttemptTimedOut:
		return "AttemptTimedOut"
	case EvAttemptCancelled:
		return "AttemptCancelled"
	case EvPartitionCommitted:
		return "PartitionCommitted"
	case EvResultRejected:
		return "ResultRejected"
	case EvTaskFailed:
		return "TaskFailed"
	case EvHoldPlaced:
		return "HoldPlaced"
	case EvUsageBilled:
		return "UsageBilled"
	case EvHoldReleased:
		return "HoldReleased"
	default:
		return "Unknown"
	}
}

// AttemptKind 区分首次/重试尝试与分位数触发的推测副本。
type AttemptKind uint8

const (
	AttemptOriginal AttemptKind = iota + 1
	AttemptRetry
	AttemptSpeculative
)

func (k AttemptKind) String() string {
	switch k {
	case AttemptOriginal:
		return "original"
	case AttemptRetry:
		return "retry"
	case AttemptSpeculative:
		return "speculative"
	default:
		return "unknown"
	}
}

// RejectReason 解释一个结果为何未被接受。
type RejectReason uint8

const (
	RejectUnknownAttempt RejectReason = iota + 1
	RejectAttemptNotRunning
	RejectTaskAlreadyCommitted
	RejectValidationFailed
	RejectExecutorMismatch
)

func (r RejectReason) String() string {
	switch r {
	case RejectUnknownAttempt:
		return "unknown_attempt"
	case RejectAttemptNotRunning:
		return "attempt_not_running"
	case RejectTaskAlreadyCommitted:
		return "task_already_committed"
	case RejectValidationFailed:
		return "validation_failed"
	case RejectExecutorMismatch:
		return "executor_mismatch"
	default:
		return "unknown"
	}
}

// Event 是协调器的不可变状态变更记录。协调器本身不读取时钟，
// 所有事件时间由调用方通过方法参数提供，从而保证重放是确定性的。
type Event struct {
	Seq        int64
	At         time.Time
	Type       EventType
	ExecutorID ExecutorID
	TaskID     TaskID
	AttemptID  AttemptID
	Partition  ShufflePartition
	Kind       AttemptKind
	Reason     RejectReason
	Payload    string
	// Resource 仅用于资源计费事件。
	Resource ResourceSpec
	// Runtime 用于 AttemptSucceeded（成功尝试的运行时长）与
	// AttemptScheduled（被替换尝试的已运行时长，0 表示新调度）。
	Runtime time.Duration
}
