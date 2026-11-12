package streamdl

import (
	"net/http"
	"strconv"
	"strings"
)

func start(handler http.Handler) *pipeServer {
	return newPipeServer(handler)
}

// staticHandler serves data with strong ETag semantics and correct ranges.
func staticHandler(data []byte, etag string, log *requestLog) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		w.Header().Set("ETag", etag)
		if rng := r.Header.Get("Range"); rng != "" {
			start, ok := parseSuffixRange(rng)
			if !ok || start >= int64(len(data)) {
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			write206(w, r, data, etag, start, int64(len(data))-1)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	})
}

func staticServer(data []byte, etag string, log *requestLog) *pipeServer {
	return start(staticHandler(data, etag, log))
}

// emptyServer serves a zero-length entity with a strong ETag.
func emptyServer(etag string, log *requestLog) *pipeServer {
	return start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		w.Header().Set("ETag", etag)
		w.Header().Set("Content-Length", "0")
		w.WriteHeader(http.StatusOK)
	}))
}

// cutServer closes the connection after cutAt bytes of the first full GET.
// Subsequent requests behave like a correct static server, enabling resume.
func cutServer(data []byte, etag string, cutAt int64, log *requestLog) *pipeServer {
	cut := true
	return start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		w.Header().Set("ETag", etag)
		if rng := r.Header.Get("Range"); rng != "" {
			start, ok := parseSuffixRange(rng)
			if !ok {
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			write206(w, r, data, etag, start, int64(len(data))-1)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		if cut && cutAt > 0 {
			cut = false
			// Hijack and close mid-body to simulate a hard connection drop.
			hj, ok := w.(http.Hijacker)
			if !ok {
				return
			}
			conn, buf, err := hj.Hijack()
			if err != nil {
				return
			}
			_, _ = buf.Write(data[:cutAt])
			_ = buf.Flush()
			// Half-close the write side so the client observes EOF after the
			// partial body, then drop the connection.
			if wc, ok := conn.(interface{ CloseWrite() error }); ok {
				_ = wc.CloseWrite()
			}
			_ = conn.Close()
			return
		}
		_, _ = w.Write(data)
	}))
}

// rotationServer holds two versions. When forceRotate is true, every request
// returns the current v2 entity with 200 (entity rotated underneath the
// client). Otherwise a resume whose If-Range still matches v1 gets a 206 and
// any other request receives a fresh 200 for v2.
func rotationServer(v1, v2 []byte, etag1, etag2 string, forceRotate bool, log *requestLog) *pipeServer {
	return start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		ifRange := r.Header.Get("If-Range")
		rangeHdr := r.Header.Get("Range")

		// RFC 9110: a Range request is honored only when If-Range still
		// matches the current representation.
		if !forceRotate && rangeHdr != "" && ifRange == etag1 {
			start, ok := parseSuffixRange(rangeHdr)
			if !ok {
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			write206(w, r, v1, etag1, start, int64(len(v1))-1)
			return
		}

		// No valid precondition (first contact, or a rotated entity): the
		// server restarts with the current entity v2.
		data, etag := v2, etag2
		w.Header().Set("ETag", etag)
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))
}

// badRangeServer returns a 206 whose metadata/body violates the contract,
// selected by mode: "start", "end", "total", "etag", "body", "header".
func badRangeServer(data []byte, etag string, mode string, log *requestLog) *pipeServer {
	return start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		total := int64(len(data))
		start, _ := parseSuffixRange(r.Header.Get("Range"))
		end := total - 1
		respEtag := etag
		switch mode {
		case "start":
			start++
		case "end":
			end--
		case "total":
			total++
		case "etag":
			respEtag = "\"other-entity\""
		}
		w.Header().Set("ETag", respEtag)
		if mode != "header" {
			w.Header().Set("Content-Range",
				"bytes "+itoa(start)+"-"+itoa(end)+"/"+itoa(total))
		}
		body := data[start:]
		if mode == "body" {
			body = append(append([]byte(nil), body...), 0xEE)
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(body)
	}))
}

// stallServer writes prefix bytes of the first full body and then blocks until
// the request context is canceled, simulating a mid-body stall.
func stallServer(data []byte, etag string, prefix int, log *requestLog) *pipeServer {
	return start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		w.Header().Set("ETag", etag)
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data[:prefix])
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-r.Context().Done()
	}))
}

// statusServer answers every request with the given status.
func statusServer(status int, log *requestLog) *pipeServer {
	return start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		w.WriteHeader(status)
	}))
}

// missingEtagServer serves 200 without an ETag.
func missingEtagServer(data []byte, log *requestLog) *pipeServer {
	return start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))
}

// weakEtagServer serves 200 with only a weak validator.
func weakEtagServer(data []byte, etag string, log *requestLog) *pipeServer {
	return start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		w.Header().Set("ETag", "W/"+strings.TrimPrefix(etag, "\""))
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))
}

// parseSuffixRange parses "bytes=N-" into N.
func parseSuffixRange(value string) (int64, bool) {
	const prefix = "bytes="
	if !strings.HasPrefix(value, prefix) || !strings.HasSuffix(value, "-") {
		return 0, false
	}
	n, err := strconv.ParseInt(value[len(prefix):len(value)-1], 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}
