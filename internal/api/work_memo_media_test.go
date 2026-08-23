package api

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v5"
	"modernc.org/sqlite"

	iauth "github.com/songtianlun/diarum/internal/auth"
	"github.com/songtianlun/diarum/internal/store"
)

var workMemoMediaJSONHeaders = map[string]string{"Content-Type": "application/json"}

// registerWorkMemoMediaTestRoutes builds an Echo server with the work memo
// (including media association) routes registered behind the same test auth
// middleware the existing work memo API tests use. The middleware sets the
// current user through auth.CurrentUser, so requests still pass through the
// auth.CurrentUser boundary exactly like production.
func registerWorkMemoMediaTestRoutes(t *testing.T, s *store.Store, user *store.User) *echo.Echo {
	t.Helper()
	e := echo.New()
	RegisterWorkMemoRoutes(e, s, authMiddlewareFor(user))
	return e
}

func createTestMemo(t *testing.T, s *store.Store, owner, content string) *store.WorkMemo {
	t.Helper()
	memo, err := s.CreateWorkMemo(owner, store.CreateWorkMemoInput{Date: "2026-08-22", Content: content})
	if err != nil {
		t.Fatalf("CreateWorkMemo %s: %v", content, err)
	}
	return memo
}

func createTestMedia(t *testing.T, s *store.Store, owner, filename string) *store.Media {
	t.Helper()
	media, err := s.CreateMedia(owner, filename, filename, "", nil)
	if err != nil {
		t.Fatalf("CreateMedia %s: %v", filename, err)
	}
	return media
}

func postWorkMemoMedia(t *testing.T, e *echo.Echo, memoID, mediaID string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"media_id":%q}`, mediaID)
	rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos/"+memoID+"/media", strings.NewReader(body), workMemoMediaJSONHeaders)
	return rec
}

// ---------------------------------------------------------------------------
// POST /api/v1/work-memos/:id/media
// ---------------------------------------------------------------------------

// P1: normal association by owner.
func TestWorkMemoMediaCreateSuccess(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)

	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")

	rec := postWorkMemoMedia(t, eA, memoA.ID, mediaA.ID)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	payload := decodeJSONBody(t, rec)
	if payload["id"] == "" || payload["id"] == nil {
		t.Fatalf("missing association id: %#v", payload)
	}
	if payload["memo_id"] != memoA.ID {
		t.Fatalf("memo_id = %v, want %s", payload["memo_id"], memoA.ID)
	}
	if payload["media_id"] != mediaA.ID {
		t.Fatalf("media_id = %v, want %s", payload["media_id"], mediaA.ID)
	}
	if int(payload["position"].(float64)) != 0 {
		t.Fatalf("position = %v, want 0", payload["position"])
	}
	if payload["created"] == "" || payload["created"] == nil {
		t.Fatalf("missing created: %#v", payload)
	}
	if _, ok := payload["owner"]; ok {
		t.Fatalf("owner must not be returned to client: %#v", payload)
	}

	items, err := s.ListWorkMemoMedia(userA.ID, memoA.ID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 association, got %d", len(items))
	}
	if items[0].ID != payload["id"] {
		t.Fatalf("stored association id = %s, want %s", items[0].ID, payload["id"])
	}
}

// P2: missing media_id field.
func TestWorkMemoMediaCreateMissingMediaID(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")

	rec := performRequest(t, eA, http.MethodPost, "/api/v1/work-memos/"+memoA.ID+"/media", strings.NewReader(`{}`), workMemoMediaJSONHeaders)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing media_id status = %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
}

// P3: empty media_id value.
func TestWorkMemoMediaCreateEmptyMediaID(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")

	rec := performRequest(t, eA, http.MethodPost, "/api/v1/work-memos/"+memoA.ID+"/media", strings.NewReader(`{"media_id":""}`), workMemoMediaJSONHeaders)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty media_id status = %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
}

// P4: malformed JSON.
func TestWorkMemoMediaCreateInvalidJSON(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")

	rec := performRequest(t, eA, http.MethodPost, "/api/v1/work-memos/"+memoA.ID+"/media", strings.NewReader(`{not-json`), workMemoMediaJSONHeaders)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid json status = %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
}

// Empty body must also be rejected with 400 (covered by the invalid/empty
// request contract; verified separately to be explicit).
func TestWorkMemoMediaCreateEmptyBody(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")

	rec := performRequest(t, eA, http.MethodPost, "/api/v1/work-memos/"+memoA.ID+"/media", strings.NewReader(``), workMemoMediaJSONHeaders)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty body status = %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
}

// P5: user B requesting an association on user A's memo.
func TestWorkMemoMediaCreateCrossOwnerMemo(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eB := registerWorkMemoMediaTestRoutes(t, s, userB)

	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")

	rec := postWorkMemoMedia(t, eB, memoA.ID, mediaA.ID)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross-owner memo status = %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
}

// P6: user A's memo but user B's media.
func TestWorkMemoMediaCreateCrossOwnerMedia(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)

	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaB := createTestMedia(t, s, userB.ID, "b.png")

	rec := postWorkMemoMedia(t, eA, memoA.ID, mediaB.ID)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross-owner media status = %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
}

// P7: non-existent memo.
func TestWorkMemoMediaCreateMissingMemo(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	mediaA := createTestMedia(t, s, userA.ID, "a.png")

	rec := postWorkMemoMedia(t, eA, "r00000000000000", mediaA.ID)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing memo status = %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
}

// P8: non-existent media.
func TestWorkMemoMediaCreateMissingMedia(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")

	rec := postWorkMemoMedia(t, eA, memoA.ID, "r00000000000000")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing media status = %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
}

// P9: duplicate association returns 409 and leaves exactly one row.
func TestWorkMemoMediaCreateDuplicateReturns409(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")

	rec := postWorkMemoMedia(t, eA, memoA.ID, mediaA.ID)
	if rec.Code != http.StatusCreated {
		t.Fatalf("first create status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = postWorkMemoMedia(t, eA, memoA.ID, mediaA.ID)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate create status = %d, want 409 body=%s", rec.Code, rec.Body.String())
	}

	var count int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM work_memo_media WHERE memo_id = ? AND media_id = ?`, memoA.ID, mediaA.ID).Scan(&count); err != nil {
		t.Fatalf("count duplicate association: %v", err)
	}
	if count != 1 {
		t.Fatalf("duplicate association count = %d, want 1", count)
	}
}

// Owner injection via request body must not change the association owner.
func TestWorkMemoMediaCreateIgnoresOwnerInjection(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)

	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")

	body := fmt.Sprintf(`{"media_id":%q,"owner":%q}`, mediaA.ID, userB.ID)
	rec := performRequest(t, eA, http.MethodPost, "/api/v1/work-memos/"+memoA.ID+"/media", strings.NewReader(body), workMemoMediaJSONHeaders)
	if rec.Code != http.StatusCreated {
		t.Fatalf("owner-injection create status = %d body=%s", rec.Code, rec.Body.String())
	}

	// Association must exist under user A, never under user B.
	itemsA, err := s.ListWorkMemoMedia(userA.ID, memoA.ID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia A: %v", err)
	}
	if len(itemsA) != 1 {
		t.Fatalf("association should belong to user A: count=%d", len(itemsA))
	}
	itemsB, err := s.ListWorkMemoMedia(userB.ID, memoA.ID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia B: %v", err)
	}
	if len(itemsB) != 0 {
		t.Fatalf("association must NOT belong to injected owner B: count=%d", len(itemsB))
	}
}

// ---------------------------------------------------------------------------
// GET /api/v1/work-memos/:id/media
// ---------------------------------------------------------------------------

// G1: correct count for a memo with several associations.
func TestWorkMemoMediaListCount(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")

	for i := 0; i < 3; i++ {
		media := createTestMedia(t, s, userA.ID, fmt.Sprintf("m%d.png", i))
		if _, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, media.ID); err != nil {
			t.Fatalf("CreateWorkMemoMedia %d: %v", i, err)
		}
	}

	rec := performRequest(t, eA, http.MethodGet, "/api/v1/work-memos/"+memoA.ID+"/media", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	payload := decodeJSONBody(t, rec)
	media, ok := payload["media"].([]any)
	if !ok {
		t.Fatalf("media field missing or wrong type: %#v", payload)
	}
	if len(media) != 3 {
		t.Fatalf("expected 3 associations, got %d", len(media))
	}
}

// G2: position order is preserved from the Store.
func TestWorkMemoMediaListOrder(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")

	mediaIDs := make([]string, 0, 3)
	for i := 0; i < 3; i++ {
		media := createTestMedia(t, s, userA.ID, fmt.Sprintf("m%d.png", i))
		if _, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, media.ID); err != nil {
			t.Fatalf("CreateWorkMemoMedia %d: %v", i, err)
		}
		mediaIDs = append(mediaIDs, media.ID)
	}

	rec := performRequest(t, eA, http.MethodGet, "/api/v1/work-memos/"+memoA.ID+"/media", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	payload := decodeJSONBody(t, rec)
	media := payload["media"].([]any)
	for i, raw := range media {
		item := raw.(map[string]any)
		if int(item["position"].(float64)) != i {
			t.Fatalf("position %d = %v, want %d", i, item["position"], i)
		}
		if item["media_id"] != mediaIDs[i] {
			t.Fatalf("media_id at %d = %v, want %s", i, item["media_id"], mediaIDs[i])
		}
	}
}

// G3: empty memo owned by the user returns an empty (non-null) array.
func TestWorkMemoMediaListEmptyMemo(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")

	rec := performRequest(t, eA, http.MethodGet, "/api/v1/work-memos/"+memoA.ID+"/media", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list empty status = %d body=%s", rec.Code, rec.Body.String())
	}
	payload := decodeJSONBody(t, rec)
	media, ok := payload["media"].([]any)
	if !ok {
		t.Fatalf("media field missing or wrong type: %#v", payload)
	}
	if len(media) != 0 {
		t.Fatalf("expected empty array, got %d", len(media))
	}
	if media == nil {
		t.Fatal("media array must not be nil")
	}
}

// G4: user B cannot see user A's memo associations.
func TestWorkMemoMediaListCrossOwner(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eB := registerWorkMemoMediaTestRoutes(t, s, userB)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")
	if _, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, mediaA.ID); err != nil {
		t.Fatalf("CreateWorkMemoMedia: %v", err)
	}

	rec := performRequest(t, eB, http.MethodGet, "/api/v1/work-memos/"+memoA.ID+"/media", nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross-owner list status = %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
}

// G5: non-existent memo.
func TestWorkMemoMediaListMissingMemo(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)

	rec := performRequest(t, eA, http.MethodGet, "/api/v1/work-memos/r00000000000000/media", nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing memo list status = %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/work-memos/:id/media/:associationId
// ---------------------------------------------------------------------------

// D1: owner deletes their own association.
func TestWorkMemoMediaDeleteSuccess(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")
	assoc, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, mediaA.ID)
	if err != nil {
		t.Fatalf("CreateWorkMemoMedia: %v", err)
	}

	rec := performRequest(t, eA, http.MethodDelete, "/api/v1/work-memos/"+memoA.ID+"/media/"+assoc.ID, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// D2: after delete the association is gone.
func TestWorkMemoMediaDeleteRemovesAssociation(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")
	assoc, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, mediaA.ID)
	if err != nil {
		t.Fatalf("CreateWorkMemoMedia: %v", err)
	}

	rec := performRequest(t, eA, http.MethodDelete, "/api/v1/work-memos/"+memoA.ID+"/media/"+assoc.ID, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", rec.Code, rec.Body.String())
	}
	items, err := s.ListWorkMemoMedia(userA.ID, memoA.ID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected 0 associations after delete, got %d", len(items))
	}
}

// D3: after delete the media record still exists.
func TestWorkMemoMediaDeleteKeepsMedia(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")
	assoc, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, mediaA.ID)
	if err != nil {
		t.Fatalf("CreateWorkMemoMedia: %v", err)
	}

	rec := performRequest(t, eA, http.MethodDelete, "/api/v1/work-memos/"+memoA.ID+"/media/"+assoc.ID, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := s.GetMedia(mediaA.ID, userA.ID); err != nil {
		t.Fatalf("media record was deleted: %v", err)
	}
}

// D4: deleting one memo's association keeps a shared media and the other memo's
// association intact.
func TestWorkMemoMediaDeleteSharedMedia(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	memoB := createTestMemo(t, s, userA.ID, "memo-b")
	mediaX := createTestMedia(t, s, userA.ID, "shared.png")

	assocA, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, mediaX.ID)
	if err != nil {
		t.Fatalf("CreateWorkMemoMedia A: %v", err)
	}
	if _, err := s.CreateWorkMemoMedia(userA.ID, memoB.ID, mediaX.ID); err != nil {
		t.Fatalf("CreateWorkMemoMedia B: %v", err)
	}

	rec := performRequest(t, eA, http.MethodDelete, "/api/v1/work-memos/"+memoA.ID+"/media/"+assocA.ID, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete A status = %d body=%s", rec.Code, rec.Body.String())
	}

	itemsA, err := s.ListWorkMemoMedia(userA.ID, memoA.ID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia A: %v", err)
	}
	if len(itemsA) != 0 {
		t.Fatalf("memo A should have 0 associations, got %d", len(itemsA))
	}
	itemsB, err := s.ListWorkMemoMedia(userA.ID, memoB.ID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia B: %v", err)
	}
	if len(itemsB) != 1 {
		t.Fatalf("memo B should keep 1 association, got %d", len(itemsB))
	}
	if _, err := s.GetMedia(mediaX.ID, userA.ID); err != nil {
		t.Fatalf("shared media was deleted: %v", err)
	}
}

// D5: user B cannot delete user A's association.
func TestWorkMemoMediaDeleteCrossOwner(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eB := registerWorkMemoMediaTestRoutes(t, s, userB)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")
	assoc, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, mediaA.ID)
	if err != nil {
		t.Fatalf("CreateWorkMemoMedia: %v", err)
	}

	rec := performRequest(t, eB, http.MethodDelete, "/api/v1/work-memos/"+memoA.ID+"/media/"+assoc.ID, nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross-owner delete status = %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
	items, err := s.ListWorkMemoMedia(userA.ID, memoA.ID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("association must survive cross-owner delete attempt, got %d", len(items))
	}
}

// D6: correct owner but memo id in the URL does not match the association.
func TestWorkMemoMediaDeleteWrongMemoInURL(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	memoB := createTestMemo(t, s, userA.ID, "memo-b")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")
	assoc, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, mediaA.ID)
	if err != nil {
		t.Fatalf("CreateWorkMemoMedia: %v", err)
	}

	rec := performRequest(t, eA, http.MethodDelete, "/api/v1/work-memos/"+memoB.ID+"/media/"+assoc.ID, nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("wrong-memo delete status = %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
	items, err := s.ListWorkMemoMedia(userA.ID, memoA.ID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("association must survive wrong-memo delete attempt, got %d", len(items))
	}
}

// D7: non-existent association.
func TestWorkMemoMediaDeleteMissingAssociation(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	eA := registerWorkMemoMediaTestRoutes(t, s, userA)
	memoA := createTestMemo(t, s, userA.ID, "memo-a")

	rec := performRequest(t, eA, http.MethodDelete, "/api/v1/work-memos/"+memoA.ID+"/media/r00000000000000", nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing association delete status = %d, want 404 body=%s", rec.Code, rec.Body.String())
	}
}

// Unauthenticated requests must be rejected by the real auth middleware (401),
// while a valid JWT token still reaches the handlers.
func TestWorkMemoMediaUnauthenticatedRejected(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	authSvc := iauth.NewService(s)
	e := echo.New()
	RegisterWorkMemoRoutes(e, s, authSvc.Middleware)

	memoA := createTestMemo(t, s, userA.ID, "memo-a")
	mediaA := createTestMedia(t, s, userA.ID, "a.png")

	rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos/"+memoA.ID+"/media", strings.NewReader(fmt.Sprintf(`{"media_id":%q}`, mediaA.ID)), workMemoMediaJSONHeaders)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST status = %d, want 401 body=%s", rec.Code, rec.Body.String())
	}
	rec = performRequest(t, e, http.MethodGet, "/api/v1/work-memos/"+memoA.ID+"/media", nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET status = %d, want 401 body=%s", rec.Code, rec.Body.String())
	}
	rec = performRequest(t, e, http.MethodDelete, "/api/v1/work-memos/"+memoA.ID+"/media/r00000000000000", nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated DELETE status = %d, want 401 body=%s", rec.Code, rec.Body.String())
	}

	// A valid token must pass the middleware and reach the handler.
	token, err := authSvc.IssueToken(userA)
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	authHeaders := map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + token,
	}
	rec = performRequest(t, e, http.MethodPost, "/api/v1/work-memos/"+memoA.ID+"/media", strings.NewReader(fmt.Sprintf(`{"media_id":%q}`, mediaA.ID)), authHeaders)
	if rec.Code != http.StatusCreated {
		t.Fatalf("authenticated POST status = %d, want 201 body=%s", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// P1 fix: isUniqueConstraint must accept ONLY a true UNIQUE violation.
// ---------------------------------------------------------------------------

// TestIsUniqueConstraintClassification proves the narrowed duplicate detection:
//   - a genuine UNIQUE violation (SQLITE_CONSTRAINT_UNIQUE = 2067) is still
//     classified as a duplicate (HTTP 409 path);
//   - a non-UNIQUE constraint error (e.g. NOT NULL) is NOT classified as a
//     duplicate, so it can never be wrongly mapped to 409.
//
// The errors are produced by the real modernc sqlite driver against an
// in-memory database, so the test does not rely on the unexported fields of
// *sqlite.Error nor on the production Store schema.
func TestIsUniqueConstraintClassification(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open probe db: %v", err)
	}
	defer db.Close()

	// Case 1: a real UNIQUE violation must remain classified as duplicate.
	if _, err := db.Exec(`CREATE TABLE uni (id INTEGER PRIMARY KEY, code TEXT UNIQUE)`); err != nil {
		t.Fatalf("create uni table: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO uni (code) VALUES ('dup')`); err != nil {
		t.Fatalf("first uni insert: %v", err)
	}
	_, dupErr := db.Exec(`INSERT INTO uni (code) VALUES ('dup')`)
	if dupErr == nil {
		t.Fatal("expected UNIQUE constraint error, got nil")
	}
	var dupSqlite *sqlite.Error
	if !errors.As(dupErr, &dupSqlite) {
		t.Fatalf("UNIQUE error is not *sqlite.Error: %T %v", dupErr, dupErr)
	}
	if !isUniqueConstraint(dupSqlite) {
		t.Fatalf("UNIQUE violation (code %d) must be classified as duplicate", dupSqlite.Code())
	}

	// Case 2: a non-UNIQUE constraint error must NOT be classified as duplicate.
	if _, err := db.Exec(`CREATE TABLE nn (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)`); err != nil {
		t.Fatalf("create nn table: %v", err)
	}
	_, nnErr := db.Exec(`INSERT INTO nn (id, v) VALUES (1, NULL)`)
	if nnErr == nil {
		t.Fatal("expected NOT NULL constraint error, got nil")
	}
	var nnSqlite *sqlite.Error
	if !errors.As(nnErr, &nnSqlite) {
		t.Fatalf("NOT NULL error is not *sqlite.Error: %T %v", nnErr, nnErr)
	}
	if isUniqueConstraint(nnSqlite) {
		t.Fatalf("non-UNIQUE constraint error (code %d) must NOT be classified as duplicate", nnSqlite.Code())
	}
}
