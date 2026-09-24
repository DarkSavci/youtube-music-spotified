package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDelayedPlayReportCannotCrossAccounts(t *testing.T) {
	s := New(Deps{AccountScope: "account-b:channel-b"})
	for _, scope := range []string{"", "account-a:channel-a"} {
		r := httptest.NewRequest(http.MethodPost, "/v1/me/plays?account_scope="+scope, strings.NewReader(`{"plays":[]}`))
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusConflict {
			t.Fatalf("scope %q: status=%d", scope, w.Code)
		}
	}
}
