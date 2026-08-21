package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/labstack/echo/v5"

	"github.com/songtianlun/diarum/internal/store"
)

func registerWorkMemoTestRoutes(t *testing.T, s *store.Store, user *store.User) *echo.Echo {
	t.Helper()
	e := echo.New()
	RegisterWorkMemoRoutes(e, s, authMiddlewareFor(user))
	return e
}

func createWorkMemo(t *testing.T, e *echo.Echo, date, content string, tags []string) map[string]any {
	t.Helper()
	body := map[string]any{
		"date":    date,
		"content": content,
	}
	if tags != nil {
		body["tags"] = tags
	}
	raw, _ := json.Marshal(body)
	rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(string(raw)), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create work memo status = %d body=%s", rec.Code, rec.Body.String())
	}
	return decodeJSONBody(t, rec)
}

func createWorkMemoAuto(t *testing.T, e *echo.Echo, date, content string) map[string]any {
	t.Helper()
	return createWorkMemo(t, e, date, content, nil)
}

func listWorkMemos(t *testing.T, e *echo.Echo, date string) []map[string]any {
	t.Helper()
	rec := performRequest(t, e, http.MethodGet, "/api/v1/work-memos/by-date/"+date, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	payload := decodeJSONBody(t, rec)
	items := payload["memos"].([]any)
	out := make([]map[string]any, len(items))
	for i, item := range items {
		out[i] = item.(map[string]any)
	}
	return out
}

func TestWorkMemoSameDayMultipleEntries(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	date := "2026-08-21"
	m1 := createWorkMemoAuto(t, e, date, "first memo")
	m2 := createWorkMemoAuto(t, e, date, "second memo")
	m3 := createWorkMemoAuto(t, e, date, "third memo")

	ids := []string{m1["id"].(string), m2["id"].(string), m3["id"].(string)}
	for i, id := range ids {
		if id == "" {
			t.Fatalf("memo %d id is empty", i)
		}
	}

	memos := listWorkMemos(t, e, date)
	if len(memos) != 3 {
		t.Fatalf("expected 3 memos, got %d", len(memos))
	}
	for i, memo := range memos {
		if memo["date"].(string) != date {
			t.Fatalf("memo %d date mismatch: %q", i, memo["date"])
		}
	}
	for i, memo := range memos {
		if int(memo["position"].(float64)) != i {
			t.Fatalf("memo %d position = %v, want %d", i, memo["position"], i)
		}
	}
}

func TestWorkMemoPositionAutoAppend(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)
	date := "2026-08-21"

	m1 := createWorkMemoAuto(t, e, date, "first")
	if int(m1["position"].(float64)) != 0 {
		t.Fatalf("first auto position = %v, want 0", m1["position"])
	}

	m2 := createWorkMemoAuto(t, e, date, "second")
	if int(m2["position"].(float64)) != 1 {
		t.Fatalf("second auto position = %v, want 1", m2["position"])
	}

	m3 := createWorkMemoAuto(t, e, date, "third")
	if int(m3["position"].(float64)) != 2 {
		t.Fatalf("third auto position = %v, want 2", m3["position"])
	}
}

func TestWorkMemoCreateIgnoresClientPosition(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)
	date := "2026-08-21"

	body := map[string]any{"date": date, "content": "ignored", "position": 999}
	raw, _ := json.Marshal(body)
	rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(string(raw)), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	memo := decodeJSONBody(t, rec)
	if int(memo["position"].(float64)) != 0 {
		t.Fatalf("client position should be ignored, got %v", memo["position"])
	}
}

func TestWorkMemoUpdateIgnoresClientPosition(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)
	date := "2026-08-21"

	memo := createWorkMemoAuto(t, e, date, "original")
	id := memo["id"].(string)
	originalPos := int(memo["position"].(float64))

	body := `{"content":"changed","position":999}`
	rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeJSONBody(t, rec)
	if updated["content"] != "changed" {
		t.Fatalf("content not updated")
	}
	if int(updated["position"].(float64)) != originalPos {
		t.Fatalf("position changed from %d to %v", originalPos, updated["position"])
	}
}

func TestWorkMemoConcurrentCreation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)
	date := "2026-08-21"

	const n = 10
	var wg sync.WaitGroup
	results := make(chan map[string]any, n)
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			body := map[string]any{"date": date, "content": fmt.Sprintf("concurrent %d", idx)}
			raw, _ := json.Marshal(body)
			rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(string(raw)), map[string]string{"Content-Type": "application/json"})
			if rec.Code != http.StatusOK {
				errs <- fmt.Errorf("request %d status = %d body=%s", idx, rec.Code, rec.Body.String())
				return
			}
			results <- decodeJSONBody(t, rec)
		}(i)
	}
	wg.Wait()
	close(results)
	close(errs)

	for err := range errs {
		t.Fatal(err)
	}

	positions := make(map[int]struct{})
	count := 0
	for memo := range results {
		count++
		pos := int(memo["position"].(float64))
		if _, exists := positions[pos]; exists {
			t.Fatalf("duplicate position %d", pos)
		}
		positions[pos] = struct{}{}
	}
	if count != n {
		t.Fatalf("expected %d created memos, got %d", n, count)
	}
	for i := 0; i < n; i++ {
		if _, ok := positions[i]; !ok {
			t.Fatalf("missing position %d", i)
		}
	}
}

func TestWorkMemoDateIsolation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-21", "day one")
	createWorkMemoAuto(t, e, "2026-08-21", "day one again")
	createWorkMemoAuto(t, e, "2026-08-22", "day two")

	if len(listWorkMemos(t, e, "2026-08-21")) != 2 {
		t.Fatalf("expected 2 memos on 2026-08-21")
	}
	if len(listWorkMemos(t, e, "2026-08-22")) != 1 {
		t.Fatalf("expected 1 memo on 2026-08-22")
	}
	if len(listWorkMemos(t, e, "2026-08-23")) != 0 {
		t.Fatalf("expected 0 memos on 2026-08-23")
	}
}

func TestWorkMemoUserIsolation(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eA := registerWorkMemoTestRoutes(t, s, userA)
	eB := registerWorkMemoTestRoutes(t, s, userB)

	memo := createWorkMemoAuto(t, eA, "2026-08-21", "private")
	id := memo["id"].(string)

	rec := performRequest(t, eB, http.MethodGet, "/api/v1/work-memos/"+id, nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("userB read status = %d, want 404", rec.Code)
	}

	rec = performRequest(t, eB, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(`{"content":"hacked"}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("userB update status = %d, want 404", rec.Code)
	}

	rec = performRequest(t, eB, http.MethodDelete, "/api/v1/work-memos/"+id, nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("userB delete status = %d, want 404", rec.Code)
	}

	rec = performRequest(t, eA, http.MethodGet, "/api/v1/work-memos/"+id, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("userA read status = %d, want 200", rec.Code)
	}
}

func TestWorkMemoListUserIsolation(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eA := registerWorkMemoTestRoutes(t, s, userA)
	eB := registerWorkMemoTestRoutes(t, s, userB)
	date := "2026-08-21"

	createWorkMemoAuto(t, eA, date, "A1")
	createWorkMemoAuto(t, eA, date, "A2")
	createWorkMemoAuto(t, eB, date, "B1")

	if len(listWorkMemos(t, eA, date)) != 2 {
		t.Fatalf("userA should see 2 memos")
	}
	if len(listWorkMemos(t, eB, date)) != 1 {
		t.Fatalf("userB should see 1 memo")
	}
}

func TestWorkMemoCreateIgnoresOwnerField(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eA := registerWorkMemoTestRoutes(t, s, userA)

	body := fmt.Sprintf(`{"date":"2026-08-21","content":"x","owner":"%s"}`, userB.ID)
	rec := performRequest(t, eA, http.MethodPost, "/api/v1/work-memos", strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	memo := decodeJSONBody(t, rec)
	if memo["owner"].(string) != userA.ID {
		t.Fatalf("memo owner = %q, want %q", memo["owner"], userA.ID)
	}
}

func TestWorkMemoUpdate(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	memo := createWorkMemo(t, e, "2026-08-21", "original", []string{"a", "b"})
	id := memo["id"].(string)
	created := memo["created"].(string)
	time.Sleep(10 * time.Millisecond)

	body := `{"content":"updated","status":"completed","is_pinned":true,"tags":["x"]}`
	rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeJSONBody(t, rec)
	if updated["content"] != "updated" || updated["status"] != "completed" || updated["is_pinned"] != true {
		t.Fatalf("updated payload = %#v", updated)
	}
	tags := updated["tags"].([]any)
	if len(tags) != 1 || tags[0] != "x" {
		t.Fatalf("updated tags = %#v", tags)
	}
	if updated["created"].(string) != created {
		t.Fatalf("created changed unexpectedly")
	}
	if updated["updated"].(string) <= created {
		t.Fatalf("updated not refreshed: %s <= %s", updated["updated"], created)
	}
}

func TestWorkMemoUpdateStatusOmittedKeepsValue(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	memo := createWorkMemoAuto(t, e, "2026-08-21", "x")
	id := memo["id"].(string)

	rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(`{"content":"changed"}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeJSONBody(t, rec)
	if updated["status"] != "normal" {
		t.Fatalf("status changed unexpectedly: %v", updated["status"])
	}
	if updated["content"] != "changed" {
		t.Fatalf("content not changed")
	}
}

func TestWorkMemoUpdateStatusValidation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	memo := createWorkMemoAuto(t, e, "2026-08-21", "x")
	id := memo["id"].(string)

	for _, status := range []string{"normal", "pending", "completed"} {
		body := fmt.Sprintf(`{"status":"%s"}`, status)
		rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for status %q, got %d", status, rec.Code)
		}
	}

	invalidCases := []struct {
		name string
		body string
	}{
		{"null", `{"status":null}`},
		{"empty", `{"status":""}`},
		{"invalid", `{"status":"done"}`},
	}
	for _, tc := range invalidCases {
		t.Run(tc.name, func(t *testing.T) {
			rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(tc.body), map[string]string{"Content-Type": "application/json"})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400 for %s, got %d body=%s", tc.name, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestWorkMemoPartialUpdateDoesNotOverwrite(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	memo := createWorkMemo(t, e, "2026-08-21", "original content", []string{"tag1"})
	id := memo["id"].(string)

	rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(`{"status":"pending"}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status update status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(`{"content":"new content"}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("content update status = %d body=%s", rec.Code, rec.Body.String())
	}
	result := decodeJSONBody(t, rec)
	if result["content"] != "new content" {
		t.Fatalf("content not updated: %#v", result)
	}
	if result["status"] != "pending" {
		t.Fatalf("status overwritten: %#v", result)
	}

	rec = performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(`{"status":"completed"}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status update 2 status = %d body=%s", rec.Code, rec.Body.String())
	}
	result = decodeJSONBody(t, rec)
	if result["content"] != "new content" {
		t.Fatalf("content overwritten: %#v", result)
	}
	if result["status"] != "completed" {
		t.Fatalf("status not updated: %#v", result)
	}
}

func TestWorkMemoDelete(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)
	date := "2026-08-21"

	m1 := createWorkMemoAuto(t, e, date, "keep")
	m2 := createWorkMemoAuto(t, e, date, "remove")

	rec := performRequest(t, e, http.MethodDelete, "/api/v1/work-memos/"+m2["id"].(string), nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = performRequest(t, e, http.MethodDelete, "/api/v1/work-memos/"+m2["id"].(string), nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete again status = %d, want 404", rec.Code)
	}

	memos := listWorkMemos(t, e, date)
	if len(memos) != 1 {
		t.Fatalf("expected 1 memo after delete, got %d", len(memos))
	}
	if memos[0]["id"] != m1["id"] {
		t.Fatalf("remaining memo id mismatch")
	}
}

func TestWorkMemoReorder(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)
	date := "2026-08-21"

	m1 := createWorkMemoAuto(t, e, date, "one")
	m2 := createWorkMemoAuto(t, e, date, "two")
	m3 := createWorkMemoAuto(t, e, date, "three")

	ids := []string{m3["id"].(string), m1["id"].(string), m2["id"].(string)}
	body := fmt.Sprintf(`{"date":"%s","ids":["%s","%s","%s"]}`, date, ids[0], ids[1], ids[2])
	rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos/reorder", strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("reorder status = %d body=%s", rec.Code, rec.Body.String())
	}
	memos := listWorkMemos(t, e, date)
	if len(memos) != 3 {
		t.Fatalf("expected 3 memos, got %d", len(memos))
	}
	for i, memo := range memos {
		if memo["id"] != ids[i] {
			t.Fatalf("position %d: expected id %s, got %s", i, ids[i], memo["id"])
		}
		if int(memo["position"].(float64)) != i {
			t.Fatalf("position %d: position value = %v, want %d", i, memo["position"], i)
		}
	}
}

func TestWorkMemoReorderValidation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)
	date := "2026-08-21"

	m1 := createWorkMemoAuto(t, e, date, "one")
	m2 := createWorkMemoAuto(t, e, date, "two")
	m3 := createWorkMemoAuto(t, e, date, "three")
	ids := []string{m1["id"].(string), m2["id"].(string), m3["id"].(string)}

	otherDateMemo := createWorkMemoAuto(t, e, "2026-08-22", "other date")
	otherUser := newTestUser(t, s)
	eOther := registerWorkMemoTestRoutes(t, s, otherUser)
	otherUserMemo := createWorkMemoAuto(t, eOther, date, "other user")

	original := listWorkMemos(t, e, date)

	cases := []struct {
		name string
		ids  []string
	}{
		{"duplicate", []string{ids[0], ids[0], ids[1]}},
		{"missing", []string{ids[0], ids[1]}},
		{"extra", append(ids, ids[0])},
		{"nonexistent", []string{ids[0], ids[1], "r00000000000000"}},
		{"other date", []string{ids[0], ids[1], otherDateMemo["id"].(string)}},
		{"other user", []string{ids[0], ids[1], otherUserMemo["id"].(string)}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bodyRaw, _ := json.Marshal(map[string]any{"date": date, "ids": tc.ids})
			rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos/reorder", strings.NewReader(string(bodyRaw)), map[string]string{"Content-Type": "application/json"})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}
			after := listWorkMemos(t, e, date)
			if len(after) != len(original) {
				t.Fatalf("memo count changed after failed reorder")
			}
			for i := range original {
				if after[i]["id"] != original[i]["id"] {
					t.Fatalf("order changed after failed reorder at position %d", i)
				}
			}
		})
	}
}

func TestWorkMemoMoveAcrossDates(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-22", "existing target 1")
	createWorkMemoAuto(t, e, "2026-08-22", "existing target 2")
	memo := createWorkMemoAuto(t, e, "2026-08-21", "move me")
	id := memo["id"].(string)

	body := `{"date":"2026-08-22"}`
	rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("move status = %d body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeJSONBody(t, rec)
	if updated["date"].(string) != "2026-08-22" {
		t.Fatalf("date not moved: %q", updated["date"])
	}
	if int(updated["position"].(float64)) != 2 {
		t.Fatalf("expected position 2 after cross-date move, got %v", updated["position"])
	}

	if len(listWorkMemos(t, e, "2026-08-21")) != 0 {
		t.Fatalf("expected 0 memos on old date")
	}
	target := listWorkMemos(t, e, "2026-08-22")
	if len(target) != 3 {
		t.Fatalf("expected 3 memos on new date, got %d", len(target))
	}
	if target[2]["id"] != id {
		t.Fatalf("moved memo should be last")
	}
}

func TestWorkMemoPinnedSort(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)
	date := "2026-08-21"

	m1 := createWorkMemoAuto(t, e, date, "unpinned first")
	body2 := map[string]any{"date": date, "content": "pinned later", "is_pinned": true}
	raw2, _ := json.Marshal(body2)
	rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(string(raw2)), map[string]string{"Content-Type": "application/json"})
	m2 := decodeJSONBody(t, rec)

	memos := listWorkMemos(t, e, date)
	if memos[0]["id"] != m2["id"] {
		t.Fatalf("pinned memo should be first, got %#v", memos)
	}
	if memos[1]["id"] != m1["id"] {
		t.Fatalf("unpinned memo should be second, got %#v", memos)
	}
}

func TestWorkMemoTagsSemantics(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)
	id := ""

	t.Run("create without tags defaults to empty array", func(t *testing.T) {
		memo := createWorkMemo(t, e, "2026-08-21", "no tags", nil)
		id = memo["id"].(string)
		tags := memo["tags"].([]any)
		if len(tags) != 0 {
			t.Fatalf("expected empty tags, got %#v", tags)
		}
	})

	t.Run("create with empty array", func(t *testing.T) {
		memo := createWorkMemo(t, e, "2026-08-21", "empty tags", []string{})
		tags := memo["tags"].([]any)
		if len(tags) != 0 {
			t.Fatalf("expected empty tags, got %#v", tags)
		}
	})

	t.Run("create with tags", func(t *testing.T) {
		memo := createWorkMemo(t, e, "2026-08-21", "with tags", []string{"a", "b"})
		tags := memo["tags"].([]any)
		if len(tags) != 2 || tags[0] != "a" || tags[1] != "b" {
			t.Fatalf("expected [a b], got %#v", tags)
		}
	})

	t.Run("create with null tags rejected", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(`{"date":"2026-08-21","content":"x","tags":null}`), map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for null tags, got %d", rec.Code)
		}
	})

	t.Run("update without tags keeps value", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(`{"content":"changed"}`), map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusOK {
			t.Fatalf("update status = %d", rec.Code)
		}
		memo := decodeJSONBody(t, rec)
		tags := memo["tags"].([]any)
		if len(tags) != 0 {
			t.Fatalf("tags changed unexpectedly: %#v", tags)
		}
	})

	t.Run("update with empty array", func(t *testing.T) {
		memo := createWorkMemo(t, e, "2026-08-21", "tags to clear", []string{"x"})
		rid := memo["id"].(string)
		rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+rid, strings.NewReader(`{"tags":[]}`), map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusOK {
			t.Fatalf("update status = %d", rec.Code)
		}
		updated := decodeJSONBody(t, rec)
		tags := updated["tags"].([]any)
		if len(tags) != 0 {
			t.Fatalf("expected empty tags after update, got %#v", tags)
		}
	})

	t.Run("update with null tags rejected", func(t *testing.T) {
		rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(`{"tags":null}`), map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for null tags update, got %d", rec.Code)
		}
	})
}

func TestWorkMemoStatusValidation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	invalidStatuses := []string{"abc", "done", "", "null"}
	for _, status := range invalidStatuses {
		body := fmt.Sprintf(`{"date":"2026-08-21","content":"x","status":"%s"}`, status)
		rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for status %q, got %d", status, rec.Code)
		}
	}

	rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(`{"date":"2026-08-21","content":"x","status":null}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for status null, got %d", rec.Code)
	}
}

func TestWorkMemoDateValidation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	invalidDates := []string{"", "2026-13-40", "abc", "x", "2026/08/21", "2026-08-21T00:00:00Z", "2026-8-21"}
	for _, date := range invalidDates {
		body := fmt.Sprintf(`{"date":"%s","content":"x"}`, date)
		rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for date %q, got %d", date, rec.Code)
		}
	}

	memo := createWorkMemoAuto(t, e, "2026-08-21", "x")
	id := memo["id"].(string)
	invalidUpdateDates := []string{"2026-13-40", "abc", "2026/08/21", "2026-08-21T00:00:00Z"}
	for _, date := range invalidUpdateDates {
		body := fmt.Sprintf(`{"date":"%s"}`, date)
		rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+id, strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for update date %q, got %d", date, rec.Code)
		}
	}
}

func TestWorkMemoValidation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(`{"content":"missing date"}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create without date status = %d, want 400", rec.Code)
	}

	rec = performRequest(t, e, http.MethodPost, "/api/v1/work-memos/reorder", strings.NewReader(`{"ids":["a","b"]}`), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("reorder without date status = %d, want 400", rec.Code)
	}
}

func workMemoCalendar(t *testing.T, e *echo.Echo, month string) map[string]any {
	t.Helper()
	url := "/api/v1/work-memos/calendar?month=" + month
	rec := performRequest(t, e, http.MethodGet, url, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("calendar status = %d body=%s", rec.Code, rec.Body.String())
	}
	return decodeJSONBody(t, rec)
}

func workMemoCalendarDays(t *testing.T, e *echo.Echo, month string) map[string]int {
	t.Helper()
	payload := workMemoCalendar(t, e, month)
	if payload["month"] != month {
		t.Fatalf("month echoed = %q, want %q", payload["month"], month)
	}
	rawDays, ok := payload["days"].([]any)
	if !ok {
		t.Fatalf("days is not an array: %#v", payload["days"])
	}
	out := make(map[string]int, len(rawDays))
	for _, raw := range rawDays {
		day := raw.(map[string]any)
		date := day["date"].(string)
		out[date] = int(day["count"].(float64))
	}
	return out
}

func TestWorkMemoCalendarSameDayMultipleEntries(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-01", "one")
	createWorkMemoAuto(t, e, "2026-08-01", "two")

	days := workMemoCalendarDays(t, e, "2026-08")
	if days["2026-08-01"] != 2 {
		t.Fatalf("2026-08-01 count = %d, want 2", days["2026-08-01"])
	}
	if len(days) != 1 {
		t.Fatalf("expected exactly 1 date, got %#v", days)
	}
}

func TestWorkMemoCalendarMultipleDates(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-01", "a")
	createWorkMemoAuto(t, e, "2026-08-01", "b")
	createWorkMemoAuto(t, e, "2026-08-02", "c")
	createWorkMemoAuto(t, e, "2026-08-21", "d")
	createWorkMemoAuto(t, e, "2026-08-21", "e")
	createWorkMemoAuto(t, e, "2026-08-21", "f")

	days := workMemoCalendarDays(t, e, "2026-08")
	want := map[string]int{"2026-08-01": 2, "2026-08-02": 1, "2026-08-21": 3}
	if len(days) != len(want) {
		t.Fatalf("expected %d dates, got %#v", len(want), days)
	}
	for date, count := range want {
		if days[date] != count {
			t.Fatalf("date %s count = %d, want %d", date, days[date], count)
		}
	}
}

func TestWorkMemoCalendarUserIsolation(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eA := registerWorkMemoTestRoutes(t, s, userA)
	eB := registerWorkMemoTestRoutes(t, s, userB)

	createWorkMemoAuto(t, eA, "2026-08-01", "a1")
	createWorkMemoAuto(t, eA, "2026-08-01", "a2")
	createWorkMemoAuto(t, eA, "2026-08-02", "a3")
	createWorkMemoAuto(t, eB, "2026-08-01", "b1")
	createWorkMemoAuto(t, eB, "2026-08-01", "b2")
	createWorkMemoAuto(t, eB, "2026-08-01", "b3")
	createWorkMemoAuto(t, eB, "2026-08-01", "b4")

	daysA := workMemoCalendarDays(t, eA, "2026-08")
	wantA := map[string]int{"2026-08-01": 2, "2026-08-02": 1}
	if len(daysA) != len(wantA) {
		t.Fatalf("userA expected %d dates, got %#v", len(wantA), daysA)
	}
	for date, count := range wantA {
		if daysA[date] != count {
			t.Fatalf("userA date %s count = %d, want %d", date, daysA[date], count)
		}
	}

	daysB := workMemoCalendarDays(t, eB, "2026-08")
	if daysB["2026-08-01"] != 4 {
		t.Fatalf("userB 2026-08-01 count = %d, want 4", daysB["2026-08-01"])
	}
	if len(daysB) != 1 {
		t.Fatalf("userB expected exactly 1 date, got %#v", daysB)
	}
}

func TestWorkMemoCalendarMonthIsolation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-07-31", "prev month")
	createWorkMemoAuto(t, e, "2026-08-01", "a")
	createWorkMemoAuto(t, e, "2026-08-01", "b")
	createWorkMemoAuto(t, e, "2026-08-31", "c")
	createWorkMemoAuto(t, e, "2026-08-31", "d")
	createWorkMemoAuto(t, e, "2026-08-31", "e")
	createWorkMemoAuto(t, e, "2026-09-01", "next month")

	days := workMemoCalendarDays(t, e, "2026-08")
	want := map[string]int{"2026-08-01": 2, "2026-08-31": 3}
	if len(days) != len(want) {
		t.Fatalf("expected %d dates, got %#v", len(want), days)
	}
	for date, count := range want {
		if days[date] != count {
			t.Fatalf("date %s count = %d, want %d", date, days[date], count)
		}
	}
}

func TestWorkMemoCalendarEmptyMonth(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	payload := workMemoCalendar(t, e, "2026-08")
	days, ok := payload["days"].([]any)
	if !ok {
		t.Fatalf("days is not an array: %#v", payload["days"])
	}
	if len(days) != 0 {
		t.Fatalf("expected empty days array, got %#v", days)
	}
	if payload["month"] != "2026-08" {
		t.Fatalf("month = %q, want 2026-08", payload["month"])
	}
}

func TestWorkMemoCalendarMissingMonth(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	rec := performRequest(t, e, http.MethodGet, "/api/v1/work-memos/calendar", nil, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing month status = %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
}

func TestWorkMemoCalendarInvalidMonth(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	for _, month := range []string{"2026-8", "2026-13", "abc", "2026", "2026-08-01", "2026/08"} {
		rec := performRequest(t, e, http.MethodGet, "/api/v1/work-memos/calendar?month="+month, nil, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("month %q status = %d, want 400 body=%s", month, rec.Code, rec.Body.String())
		}
	}
}
