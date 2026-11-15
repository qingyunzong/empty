package dataeng

import (
	"context"
	"errors"
	"io"
	"time"
)

// RemoteState is the server-side state of an export job.
type RemoteState string

const (
	RemotePending RemoteState = "pending"
	RemoteRunning RemoteState = "running"
	RemoteReady   RemoteState = "ready"
	RemoteFailed  RemoteState = "failed"
)

// TaskState is the local, persisted lifecycle state of an export task.
// Terminal states (succeeded/failed/cancelled) are reached exactly once.
type TaskState string

const (
	TaskActive    TaskState = "active"
	TaskSucceeded TaskState = "succeeded"
	TaskFailed    TaskState = "failed"
	TaskCancelled TaskState = "cancelled"
)

func (s TaskState) Terminal() bool {
	return s == TaskSucceeded || s == TaskFailed || s == TaskCancelled
}

var (
	// ErrCreateTimeout is returned by ExportClient.CreateExport when the
	// request timed out; the job may or may not have been created remotely.
	ErrCreateTimeout = errors.New("dataeng: create export timed out")
	// ErrJobFailed indicates the remote export job failed.
	ErrJobFailed = errors.New("dataeng: export job failed")
	// ErrJobExpired indicates the job passed its expiry before completion.
	ErrJobExpired = errors.New("dataeng: export job expired")
	// ErrDigestMismatch indicates a downloaded shard failed digest verification.
	ErrDigestMismatch = errors.New("dataeng: shard digest mismatch")
	// ErrCancelled indicates the task was cancelled before commit.
	ErrCancelled = errors.New("dataeng: task cancelled")
	// ErrUnknownTask indicates an operation on an unregistered task.
	ErrUnknownTask = errors.New("dataeng: unknown task")
)

// CreateRequest describes the report to export.
type CreateRequest struct {
	ReportType string
	Params     map[string]string
}

// Shard describes one downloadable fragment of a finished export.
type Shard struct {
	Index int
	// Digest is the expected lowercase hex SHA-256 of the shard bytes.
	Digest string
	Size   int64
}

// JobStatus is a point-in-time view of a remote export job.
type JobStatus struct {
	JobID string
	State RemoteState
	// Shards is populated once State is RemoteReady.
	Shards []Shard
	// ExpiresAt is the deadline after which the remote job (and its
	// shards) may be discarded. Zero means no known expiry.
	ExpiresAt time.Time
}

// Task is the unit of work driven by Runner.
type Task struct {
	ID string
	// IdempotencyKey uniquely identifies the logical export; it is used to
	// recover the remote job id after create timeouts and across restarts.
	IdempotencyKey string
	Request        CreateRequest
}

// ExportClient abstracts the upstream asynchronous export service.
type ExportClient interface {
	// CreateExport starts an export. It must return an error wrapping
	// ErrCreateTimeout when the outcome is unknown due to a timeout.
	CreateExport(ctx context.Context, req CreateRequest) (jobID string, err error)
	// FindByIdempotencyKey returns the job previously created with key.
	FindByIdempotencyKey(ctx context.Context, key string) (jobID string, found bool, err error)
	// Status reports the current state of a job.
	Status(ctx context.Context, jobID string) (JobStatus, error)
	// DownloadShard streams one shard of a ready job. The caller verifies
	// the digest before persisting.
	DownloadShard(ctx context.Context, jobID string, index int) (io.ReadCloser, error)
	// Cancel best-effort cancels a remote job.
	Cancel(ctx context.Context, jobID string) error
}

// PersistedShard is a verified shard handed to the Store.
type PersistedShard struct {
	Index  int
	Digest string
	Data   []byte
}

// Store persists task state. All terminal transitions are compare-and-swap
// so that completion and cancellation race to a single winner.
type Store interface {
	// RegisterTask records a new active task; it is a no-op if the task
	// already exists (safe for resume after restart).
	RegisterTask(ctx context.Context, taskID string) error
	// LoadJob returns the remote job id persisted for an idempotency key.
	LoadJob(ctx context.Context, idempotencyKey string) (jobID string, ok bool, err error)
	// SaveJob persists the idempotency-key -> job mapping for a task.
	SaveJob(ctx context.Context, taskID, idempotencyKey, jobID string) error
	// JobFor returns the remote job id bound to a task.
	JobFor(ctx context.Context, taskID string) (jobID string, ok bool, err error)
	// SaveShard persists a verified shard; idempotent by (taskID, index).
	SaveShard(ctx context.Context, taskID string, shard PersistedShard) error
	// State returns the current task state.
	State(ctx context.Context, taskID string) (TaskState, error)
	// TryCommit atomically marks the task succeeded iff it is still active
	// and exactly wantShards distinct shards are persisted. It returns
	// false when the task already reached a terminal state.
	TryCommit(ctx context.Context, taskID string, wantShards int) (bool, error)
	// TryCancel atomically marks the task cancelled iff it is still active.
	TryCancel(ctx context.Context, taskID string) (bool, error)
	// TryFail atomically marks the task failed iff it is still active.
	TryFail(ctx context.Context, taskID string) (bool, error)
}
