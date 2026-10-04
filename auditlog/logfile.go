package main

import (
	"errors"
	"fmt"
	"io"
	"os"
)

// appendFrame appends one frame to the log. When autoSeq is true the
// sequence number is lastSeq+1 (1 for an empty log). It refuses to append
// to a corrupt log or one with an incomplete tail frame.
func appendFrame(path string, seq uint64, autoSeq bool, payload []byte) (uint64, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return 0, err
	}
	frames, goodEnd, err := scanFrames(f)
	if err != nil {
		return 0, fmt.Errorf("refusing to append to corrupt log: %w", err)
	}
	if goodEnd != fi.Size() {
		return 0, fmt.Errorf("log has %d trailing bytes of an incomplete frame; run recover first", fi.Size()-goodEnd)
	}
	if autoSeq {
		seq = 1
		if n := len(frames); n > 0 {
			seq = frames[n-1].Seq + 1
		}
	} else {
		for _, fr := range frames {
			if fr.Seq == seq {
				return 0, fmt.Errorf("sequence %d already exists", seq)
			}
		}
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		return 0, err
	}
	if _, err := f.Write(encodeFrame(seq, payload)); err != nil {
		return 0, err
	}
	if err := f.Sync(); err != nil {
		return 0, err
	}
	return seq, nil
}

// recoverLog truncates only an incomplete tail frame (torn write). If a
// complete frame fails its checksum anywhere in the file, an error is
// returned and the original file is left byte-for-byte unmodified.
func recoverLog(path string) (truncated int64, err error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0o644)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return 0, err
	}
	_, goodEnd, err := scanFrames(f)
	if err != nil {
		var ce *CorruptError
		if errors.As(err, &ce) {
			return 0, fmt.Errorf("%w; original file left unmodified", err)
		}
		return 0, err
	}
	if goodEnd == fi.Size() {
		return 0, nil
	}
	if err := f.Truncate(goodEnd); err != nil {
		return 0, err
	}
	return fi.Size() - goodEnd, nil
}

type verifyResult struct {
	Frames    int
	FirstSeq  uint64
	LastSeq   uint64
	TailBytes int64 // bytes of an incomplete trailing frame
}

func verifyLog(path string) (verifyResult, error) {
	var res verifyResult
	f, err := os.Open(path)
	if err != nil {
		return res, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return res, err
	}
	frames, goodEnd, err := scanFrames(f)
	if err != nil {
		return res, err
	}
	res.Frames = len(frames)
	if len(frames) > 0 {
		res.FirstSeq = frames[0].Seq
		res.LastSeq = frames[len(frames)-1].Seq
	}
	res.TailBytes = fi.Size() - goodEnd
	return res, nil
}
