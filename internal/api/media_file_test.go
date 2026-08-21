package api

import (
	"bytes"
	"net/http"
	"testing"

	"github.com/labstack/echo/v5"

	"github.com/songtianlun/diarum/internal/auth"
)

func TestMediaFileRouteAuthorization(t *testing.T) {
	s := newTestStore(t)
	owner := newTestUser(t, s)
	otherUser := newTestUser(t, s)

	media, err := s.CreateMedia(owner.ID, "photo.png", "Photo", "", nil)
	if err != nil {
		t.Fatalf("CreateMedia: %v", err)
	}
	wantContent := pngBytes()
	if err := s.SaveUploadedMedia(media, bytes.NewReader(wantContent)); err != nil {
		t.Fatalf("SaveUploadedMedia: %v", err)
	}

	authService := auth.NewService(s)
	ownerToken, err := authService.IssueToken(owner)
	if err != nil {
		t.Fatalf("IssueToken owner: %v", err)
	}
	otherToken, err := authService.IssueToken(otherUser)
	if err != nil {
		t.Fatalf("IssueToken other user: %v", err)
	}

	e := echo.New()
	RegisterMediaRoutes(e, s, authService.Middleware)
	filePath := "/api/v1/files/media/" + media.ID + "/" + media.File

	t.Run("owner reads file with authorization header", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodGet, filePath, nil, map[string]string{
			"Authorization": "Bearer " + ownerToken,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		if !bytes.Equal(rec.Body.Bytes(), wantContent) {
			t.Fatalf("content = %q, want %q", rec.Body.Bytes(), wantContent)
		}
		assertPrivateMediaNoStore(t, rec.Header().Get("Cache-Control"))
	})

	t.Run("owner reads file with browser media cookie", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodGet, filePath, nil, map[string]string{
			"Cookie": mediaAuthCookieName + "=" + ownerToken,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		if !bytes.Equal(rec.Body.Bytes(), wantContent) {
			t.Fatalf("content = %q, want %q", rec.Body.Bytes(), wantContent)
		}
		assertPrivateMediaNoStore(t, rec.Header().Get("Cache-Control"))
	})

	t.Run("anonymous request is rejected", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodGet, filePath, nil, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		assertPrivateMediaNoStore(t, rec.Header().Get("Cache-Control"))
	})

	t.Run("invalid authorization does not fall back to cookie", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodGet, filePath, nil, map[string]string{
			"Authorization": "Bearer invalid-token",
			"Cookie":        mediaAuthCookieName + "=" + ownerToken,
		})
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		assertPrivateMediaNoStore(t, rec.Header().Get("Cache-Control"))
	})

	t.Run("other user cannot read owner file", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodGet, filePath, nil, map[string]string{
			"Authorization": "Bearer " + otherToken,
		})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		assertPrivateMediaNoStore(t, rec.Header().Get("Cache-Control"))
	})

	t.Run("missing media remains not found", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodGet, "/api/v1/files/media/missing/photo.png", nil, map[string]string{
			"Authorization": "Bearer " + ownerToken,
		})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		assertPrivateMediaNoStore(t, rec.Header().Get("Cache-Control"))
	})

	t.Run("wrong filename is not served", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodGet, "/api/v1/files/media/"+media.ID+"/wrong.png", nil, map[string]string{
			"Authorization": "Bearer " + ownerToken,
		})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		assertPrivateMediaNoStore(t, rec.Header().Get("Cache-Control"))
	})
}

func assertPrivateMediaNoStore(t *testing.T, cacheControl string) {
	t.Helper()
	if cacheControl != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want %q", cacheControl, "private, no-store")
	}
}
