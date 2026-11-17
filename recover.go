package formal

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// VisibleRecord is a commit record in the durable prefix recovered from the
// device. These are exactly the transactions a recovery procedure may make
// visible.
type VisibleRecord struct {
	TransactionID uint64
	Payload       []byte
	StartLSN      LSN
	EndLSN        LSN
	Generation    uint64
}

// RecoveryResult is the validated durable prefix of a commit log.
type RecoveryResult struct {
	Records        []VisibleRecord
	DurableLSN     LSN
	LastGeneration uint64
	TornTail       bool
}

// Recover scans complete, checksummed commit groups from the start of dev.
// Scanning stops at the first invalid or incomplete group. Bytes after that
// point are a torn or failed tail and are not visible.
func Recover(dev BlockDevice, capacity int64) (RecoveryResult, error) {
	if dev == nil {
		return RecoveryResult{}, errors.New("formal: nil block device")
	}
	if capacity <= 0 {
		if sizer, ok := dev.(SizeProvider); ok {
			size, err := sizer.Size()
			if err != nil {
				return RecoveryResult{}, fmt.Errorf("formal: determine device size: %w", err)
			}
			capacity = size
		}
	}
	if capacity <= 0 {
		return RecoveryResult{}, errors.New("formal: device capacity must be positive")
	}

	var result RecoveryResult
	off := int64(0)
	for off+groupHeaderSize <= capacity {
		header := make([]byte, groupHeaderSize)
		if err := readFullAt(dev, header, off); err != nil {
			if isCleanEnd(err) {
				break
			}
			return RecoveryResult{}, fmt.Errorf("formal: read group header at %d: %w", off, err)
		}
		if allZero(header) {
			break
		}
		if string(header[0:4]) != groupMagic ||
			binary.LittleEndian.Uint16(header[4:6]) != formatVersion ||
			binary.LittleEndian.Uint16(header[6:8]) != groupHeaderSize {
			result.TornTail = true
			break
		}
		total := binary.LittleEndian.Uint32(header[24:28])
		if total < groupHeaderSize+groupFooterSize || int64(total) > capacity-off {
			result.TornTail = true
			break
		}

		buf := make([]byte, int(total))
		copy(buf, header)
		if err := readFullAt(dev, buf[groupHeaderSize:], off+groupHeaderSize); err != nil {
			if isCleanEnd(err) {
				result.TornTail = true
				break
			}
			return RecoveryResult{}, fmt.Errorf("formal: read group body at %d: %w", off, err)
		}

		records, generation, groupLen, err := decodeGroup(buf, LSN(off))
		if err != nil {
			result.TornTail = true
			break
		}
		if generation <= result.LastGeneration {
			result.TornTail = true
			break
		}

		for _, rec := range records {
			result.Records = append(result.Records, VisibleRecord{
				TransactionID: rec.txID,
				Payload:       append([]byte(nil), rec.payload...),
				StartLSN:      rec.start,
				EndLSN:        rec.end,
				Generation:    generation,
			})
		}
		result.LastGeneration = generation
		off += groupLen
		result.DurableLSN = LSN(off)
	}
	if result.DurableLSN < LSN(off) {
		result.DurableLSN = LSN(off)
	}
	return result, nil
}

// RecoverTransactions returns only the visible records from Recover.
func RecoverTransactions(dev BlockDevice, capacity int64) ([]VisibleRecord, error) {
	result, err := Recover(dev, capacity)
	if err != nil {
		return nil, err
	}
	return result.Records, nil
}

func isCleanEnd(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}

func allZero(p []byte) bool {
	for _, b := range p {
		if b != 0 {
			return false
		}
	}
	return true
}
