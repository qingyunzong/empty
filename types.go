package dataeng

import "time"

// State is the lifecycle state of a multipart upload session.
type State string

const (
	// StateActive means parts may still be uploaded.
	StateActive State = "active"
	// StateCompleting means a complete operation is in flight.
	StateCompleting State = "completing"
	// StateAborting means an abort operation is in flight.
	StateAborting State = "aborting"
	// StateCompleted is the terminal state after a successful complete.
	StateCompleted State = "completed"
	// StateAborted is the terminal state after an abort.
	StateAborted State = "aborted"
)

// Terminal reports whether the state is a final state (completed or aborted).
func (s State) Terminal() bool {
	return s == StateCompleted || s == StateAborted
}

// Part binds a part number to the ETag returned by the backend and the
// SHA-256 checksum of the exact bytes that were uploaded.
type Part struct {
	Number         int
	ETag           string
	Size           int64
	ChecksumSHA256 string
	UploadedAt     time.Time
}

// CompleteResult binds a completed session to the resulting object generation.
type CompleteResult struct {
	Generation  int64
	ETag        string
	Size        int64
	CompletedAt time.Time
}

// Session is the durable manifest of one multipart upload: which object key
// and remote upload ID it belongs to, and which parts (with checksums) have
// been recorded for it.
type Session struct {
	ID          string
	ObjectKey   string
	UploadID    string
	State       State
	Parts       map[int]*Part
	Result      *CompleteResult
	AbortReason string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	Version     int64
}

// Clone returns a deep copy of the session.
func (s *Session) Clone() *Session {
	out := *s
	if s.Parts != nil {
		out.Parts = make(map[int]*Part, len(s.Parts))
		for n, p := range s.Parts {
			cp := *p
			out.Parts[n] = &cp
		}
	}
	if s.Result != nil {
		r := *s.Result
		out.Result = &r
	}
	return &out
}

// sortedParts returns the recorded parts ordered by part number.
func (s *Session) sortedParts() []*Part {
	out := make([]*Part, 0, len(s.Parts))
	for _, p := range s.Parts {
		out = append(out, p)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Number < out[j-1].Number; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
