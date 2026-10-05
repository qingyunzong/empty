package ptxn

import (
	"encoding/json"
	"errors"
	"io"
	"os"
)

// WAL record types.
const (
	recordPrepare = "prepare"
	recordCommit  = "commit"
	recordAbort   = "abort"
)

// walRecord is one durable log entry. Prepare records carry the full
// read/write set bound to the transaction ID; commit/abort records are
// decisions and are always fsynced before they become visible anywhere.
type walRecord struct {
	Type   string            `json:"type"`
	TxnID  string            `json:"txn_id"`
	Reads  []string          `json:"reads,omitempty"`
	Writes map[string]string `json:"writes,omitempty"`
}

// wal is an append-only, fsync-on-write log.
type wal struct {
	f    *os.File
	path string
}

func openWAL(path string) (*wal, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &wal{f: f, path: path}, nil
}

// append writes one record and fsyncs it, so a returned decision is durable.
func (w *wal) append(rec walRecord) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if _, err := w.f.Write(append(b, '\n')); err != nil {
		return err
	}
	return w.f.Sync()
}

// replay feeds every complete record to fn in log order. A torn tail left
// by a crash mid-write is ignored: only fully persisted records count.
func (w *wal) replay(fn func(walRecord) error) error {
	f, err := os.Open(w.path)
	if err != nil {
		return err
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	for {
		var rec walRecord
		if err := dec.Decode(&rec); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			// Torn or partial tail from a crash: stop replaying.
			return nil
		}
		if err := fn(rec); err != nil {
			return err
		}
	}
}

func (w *wal) close() error { return w.f.Close() }
