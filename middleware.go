package q207

import (
	"context"
	"errors"
	"net/http"
)

type ctxKey struct{}

// FromContext returns the normalization Result stored by the middleware,
// or nil if the request did not pass through it.
func FromContext(ctx context.Context) *Result {
	r, _ := ctx.Value(ctxKey{}).(*Result)
	return r
}

// Middleware normalizes the query string of every incoming request.
//
// The rule version is pinned once per request, so a concurrent hot reload
// never affects a request already in flight. Rejected requests get a
// 400 response and never reach the backend. Accepted requests are
// forwarded with URL.RawQuery replaced by the canonical form; the Result
// (rule version plus raw/canonical digests) is attached to the context.
func (s *RuleStore) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		snap := s.load()
		res, err := Normalize(r.URL.RawQuery, snap.rules)
		if err != nil {
			var rej *RejectError
			if errors.As(err, &rej) {
				http.Error(w, "bad query string: "+rej.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, "query rules error", http.StatusInternalServerError)
			return
		}
		res.Version = snap.version
		r.URL.RawQuery = res.Canonical
		r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, res))
		next.ServeHTTP(w, r)
	})
}
