package q225

import "errors"

// Feed parses the next wire bytes.
//
// n is the number of bytes consumed from in; bytes beyond n belong to the
// next pipelined request and are left untouched for the handler. out holds
// decoded payload bytes (empty while waiting for framing or inside the
// trailing section). done is true exactly on the call that finishes the
// body; on that call the error is nil unless in itself contained a
// protocol violation.
//
// Incomplete input is normal: Feed returns n < len(in) with a nil error and
// the remaining bytes must be presented again alongside later reads.
func (d *Decoder) Feed(in []byte) (out []byte, n int, done bool, err error) {
	if d.err != nil {
		return nil, 0, false, fmtPoisoned(d.err)
	}
	d.out = d.out[:0]

	for n < len(in) {
		switch d.state {
		case stateNone, stateDone:
			d.completed = true
			return d.takeOut(), n, true, nil

		case stateFixed:
			available := len(in) - n
			take := available
			if cap := int(d.limits.MaxBodyBytes - d.emitted); take > cap {
				take = cap
			}
			if int64(take) > d.remaining {
				take = int(d.remaining)
			}
			if take > 0 {
				if !d.emit(in[n : n+take]) {
					return d.fail(n, ErrBodyTooLarge)
				}
				n += take
				d.remaining -= int64(take)
				d.consumed += int64(take)
			}
			if d.emitted >= d.limits.MaxBodyBytes && d.remaining > 0 {
				return d.fail(n, ErrBodyTooLarge)
			}
			if d.remaining == 0 {
				d.state = stateDone
				d.completed = true
				return d.takeOut(), n, true, nil
			}

		case stateChunkLine:
			line, used, ok := d.readLine(in[n:], d.limits.MaxChunkLine, false)
			n += used
			d.consumed += int64(used)
			if !ok {
				return d.takeOut(), n, false, d.err
			}
			if line == nil {
				return d.takeOut(), n, false, nil // need more bytes
			}
			if perr := d.beginChunk(line); perr != nil {
				return d.fail(n, perr)
			}

		case stateChunkData:
			take := int(d.remaining)
			if available := len(in) - n; available < take {
				take = available
			}
			if !d.emit(in[n : n+take]) {
				return d.fail(n, ErrBodyTooLarge)
			}
			n += take
			d.remaining -= int64(take)
			d.consumed += int64(take)
			if d.remaining == 0 {
				d.state = stateChunkCRLF
			}

		case stateChunkCRLF:
			used, status := expectCRLF(in[n:])
			n += used
			d.consumed += int64(used)
			switch status {
			case crlfNeedMore:
				return d.takeOut(), n, false, nil
			case crlfError:
				return d.fail(n, ErrCRLF)
			case crlfOK:
				d.state = stateChunkLine
			}

		case stateTrailer:
			line, used, ok := d.readLine(in[n:], d.limits.MaxTrailerBytes, true)
			n += used
			d.consumed += int64(used)
			d.trailerSz += used
			if !ok {
				return d.takeOut(), n, false, d.err
			}
			if line == nil {
				return d.takeOut(), n, false, nil // need more bytes
			}
			if d.trailerSz > d.limits.MaxTrailerBytes {
				return d.fail(n, ErrTrailerTooLarge)
			}
			if len(line) == 0 {
				d.state = stateDone
				d.completed = true
				return d.takeOut(), n, true, nil
			}
			if perr := d.addTrailer(line); perr != nil {
				return d.fail(n, perr)
			}
		}
	}
	return d.takeOut(), n, false, d.err
}

// Finish signals that the underlying connection produced no more bytes.
// It returns ErrTruncated (and poisons the decoder) unless the full body
// and its terminating CRLF were already consumed.
func (d *Decoder) Finish() error {
	if d.err != nil {
		return fmtPoisoned(d.err)
	}
	if !d.completed {
		d.err = ErrTruncated
	}
	return d.err
}

func (d *Decoder) fail(consumed int, cause error) ([]byte, int, bool, error) {
	d.err = cause
	return nil, consumed, false, cause
}

func fmtPoisoned(cause error) error {
	return errors.Join(ErrPoisoned, cause)
}

// Abort marks the decoder unusable, for example when the handler cancels a
// still-open body. Afterwards Feed and Finish return ErrPoisoned.
func (d *Decoder) Abort() {
	if d.err == nil {
		d.err = ErrPoisoned
	}
}

// Framing reports the framing selected from the request headers.
func (d *Decoder) Framing() Framing { return d.framing }

// Consumed returns the number of wire bytes the decoder has consumed; after
// a successful final Feed it is the exact end offset of this message, so the
// connection can continue reading the next request at that position.
func (d *Decoder) Consumed() int64 { return d.consumed }

// Emitted returns the number of decoded payload bytes produced so far.
func (d *Decoder) Emitted() int64 { return d.emitted }

// Trailers returns trailing header fields collected after the final chunk.
// It is empty until the trailing section has been parsed.
func (d *Decoder) Trailers() Header { return d.trailers }

// Err returns the first protocol error, or nil while the decoder is usable.
func (d *Decoder) Err() error { return d.err }

// Poisoned reports whether the decoder (and therefore its connection) must
// not be reused.
func (d *Decoder) Poisoned() bool { return d.err != nil }

func (d *Decoder) takeOut() []byte {
	out := d.out
	d.out = nil
	return out
}

// emit appends payload to the per-call output while enforcing the body
// size limit.
func (d *Decoder) emit(p []byte) bool {
	if int64(len(p)) > d.limits.MaxBodyBytes-d.emitted {
		return false
	}
	d.out = append(d.out, p...)
	d.emitted += int64(len(p))
	return true
}

// readLine accumulates one line terminated by a strict CRLF.
//
// It returns (line, used, ok) where line is nil when no complete line is
// available yet. A bare LF, a bare CR not followed by LF, or a line longer
// than limit is a hard error; ok is false with d.err set in that case.
func (d *Decoder) readLine(in []byte, limit int, trailer bool) (line []byte, used int, ok bool) {
	for used < len(in) {
		c := in[used]
		if d.crPending {
			if c != '\n' {
				d.err = ErrCRLF
				return nil, used, false
			}
			line = d.line[:len(d.line)-1] // drop the retained CR
			d.line = d.line[:0]
			d.crPending = false
			return line, used + 1, true
		}
		if len(d.line)+1 > limit {
			d.err = ErrChunkLineTooLong
			if trailer {
				d.err = ErrTrailerTooLarge
			}
			return nil, used, false
		}
		switch c {
		case '\r':
			d.line = append(d.line, c)
			d.crPending = true
			used++
			if used == len(in) {
				return nil, used, true
			}
		case '\n':
			d.err = ErrCRLF
			return nil, used, false
		default:
			d.line = append(d.line, c)
			used++
		}
	}
	return nil, used, true
}

type crlfStatus int

const (
	crlfNeedMore crlfStatus = iota
	crlfError
	crlfOK
)

// expectCRLF classifies the start of in against a strict CRLF. A lone
// leading CR means crlfNeedMore; any other non-CR byte (including a bare
// LF) is an immediate crlfError.
func expectCRLF(in []byte) (used int, status crlfStatus) {
	if len(in) == 0 {
		return 0, crlfNeedMore
	}
	if in[0] != '\r' {
		return 0, crlfError
	}
	if len(in) == 1 {
		return 0, crlfNeedMore
	}
	if in[1] != '\n' {
		return 1, crlfError
	}
	return 2, crlfOK
}
