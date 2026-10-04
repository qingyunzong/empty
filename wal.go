package txstore

import (
	"bytes"
	"encoding/binary"
	"encoding/gob"
	"os"
)

// Record types stored in the write-ahead logs.
const (
	recPrepare  byte = 1 // partition log: full read/write set bound to the txn ID
	recCommit   byte = 2 // partition log: txn applied on this partition
	recAbort    byte = 3 // partition log: txn discarded on this partition
	recDecision byte = 4 // coordinator decision log: durable cross-partition outcome
)

const (
	decideCommit = "commit"
	decideAbort  = "abort"
)

type record struct {
	Type     byte
	TxnID    string
	Decision string // decideCommit / decideAbort, only for recDecision
	Reads    []string
	Writes   map[string]string
}

// wal is an append-only log. Every append is fsynced before it returns, so a
// record that append() reported success for survives a crash.
type wal struct {
	f *os.File
}

func openWAL(path string) (*wal, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &wal{f: f}, nil
}

func (w *wal) append(r record) error {
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(r); err != nil {
		return err
	}
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(buf.Len()))
	if _, err := w.f.Write(lenBuf[:]); err != nil {
		return err
	}
	if _, err := w.f.Write(buf.Bytes()); err != nil {
		return err
	}
	return w.f.Sync()
}

func (w *wal) close() error { return w.f.Close() }

// readWAL decodes every complete record in path. A torn tail (crash in the
// middle of a write) is ignored: it was never fsynced, hence never acked.
func readWAL(path string) ([]record, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []record
	for len(data) >= 4 {
		n := binary.BigEndian.Uint32(data[:4])
		if n == 0 || len(data) < 4+int(n) {
			break
		}
		var r record
		if err := gob.NewDecoder(bytes.NewReader(data[4 : 4+int(n)])).Decode(&r); err != nil {
			break
		}
		out = append(out, r)
		data = data[4+int(n):]
	}
	return out, nil
}
