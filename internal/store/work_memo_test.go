package store

import (
	"testing"
)

func TestWorkMemoStoreCreateAutoPosition(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	date := "2026-08-21"

	m1, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: date, Content: "first"})
	if err != nil {
		t.Fatalf("create first: %v", err)
	}
	if m1.Position != 0 {
		t.Fatalf("first position = %d, want 0", m1.Position)
	}

	m2, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: date, Content: "second"})
	if err != nil {
		t.Fatalf("create second: %v", err)
	}
	if m2.Position != 1 {
		t.Fatalf("second position = %d, want 1", m2.Position)
	}

	m3, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: date, Content: "third"})
	if err != nil {
		t.Fatalf("create third: %v", err)
	}
	if m3.Position != 2 {
		t.Fatalf("third position = %d, want 2", m3.Position)
	}
}

func TestWorkMemoStoreCreateNilTagsSavedAsEmptyArray(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	memo, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: "2026-08-21", Content: "x", Tags: nil})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(memo.Tags) != 0 {
		t.Fatalf("expected empty tags, got %#v", memo.Tags)
	}

	// Verify raw database value is "[]" not "null".
	var raw string
	row := s.DB.QueryRow(`SELECT tags FROM work_memos WHERE id = ?`, memo.ID)
	if err := row.Scan(&raw); err != nil {
		t.Fatalf("scan tags: %v", err)
	}
	if raw != "[]" {
		t.Fatalf("expected raw tags '[]', got %q", raw)
	}
}

func TestWorkMemoStoreUpdateNilTagsSavedAsEmptyArray(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	memo, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: "2026-08-21", Content: "x", Tags: []string{"a"}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	nilSlice := []string(nil)
	_, err = s.UpdateWorkMemo(user.ID, memo.ID, UpdateWorkMemoInput{Tags: &nilSlice})
	if err != nil {
		t.Fatalf("update: %v", err)
	}

	updated, err := s.GetWorkMemo(memo.ID, user.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(updated.Tags) != 0 {
		t.Fatalf("expected empty tags, got %#v", updated.Tags)
	}

	var raw string
	row := s.DB.QueryRow(`SELECT tags FROM work_memos WHERE id = ?`, memo.ID)
	if err := row.Scan(&raw); err != nil {
		t.Fatalf("scan tags: %v", err)
	}
	if raw != "[]" {
		t.Fatalf("expected raw tags '[]', got %q", raw)
	}
}

func TestWorkMemoStoreCreateInvalidStatus(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	_, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: "2026-08-21", Content: "x", Status: "invalid"})
	if err == nil {
		t.Fatalf("expected error for invalid status")
	}
}

func TestWorkMemoStoreUpdateInvalidStatus(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	memo, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: "2026-08-21", Content: "x"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	status := "invalid"
	_, err = s.UpdateWorkMemo(user.ID, memo.ID, UpdateWorkMemoInput{Status: &status})
	if err == nil {
		t.Fatalf("expected error for invalid status update")
	}
}

func TestWorkMemoStoreCreateInvalidDate(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	_, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: "2026-13-40", Content: "x"})
	if err == nil {
		t.Fatalf("expected error for invalid date")
	}
}

func TestWorkMemoStoreUpdateInvalidDate(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	memo, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: "2026-08-21", Content: "x"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	date := "not-a-date"
	_, err = s.UpdateWorkMemo(user.ID, memo.ID, UpdateWorkMemoInput{Date: &date})
	if err == nil {
		t.Fatalf("expected error for invalid date update")
	}
}

func TestWorkMemoStoreUpdatePartialDoesNotOverwrite(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	memo, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: "2026-08-21", Content: "original", Tags: []string{"tag1"}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	content := "new content"
	_, err = s.UpdateWorkMemo(user.ID, memo.ID, UpdateWorkMemoInput{Content: &content})
	if err != nil {
		t.Fatalf("update content: %v", err)
	}

	updated, err := s.GetWorkMemo(memo.ID, user.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if updated.Content != "new content" {
		t.Fatalf("content not updated: %q", updated.Content)
	}
	if updated.Status != WorkMemoStatusNormal {
		t.Fatalf("status overwritten: %q", updated.Status)
	}
	if len(updated.Tags) != 1 || updated.Tags[0] != "tag1" {
		t.Fatalf("tags overwritten: %#v", updated.Tags)
	}
}

func TestWorkMemoStoreCountByMonth(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	for _, date := range []string{
		"2026-07-31",
		"2026-08-01", "2026-08-01",
		"2026-08-02",
		"2026-08-21", "2026-08-21", "2026-08-21",
		"2026-08-31", "2026-08-31", "2026-08-31",
		"2026-09-01",
	} {
		if _, err := s.CreateWorkMemo(user.ID, CreateWorkMemoInput{Date: date, Content: date}); err != nil {
			t.Fatalf("create %s: %v", date, err)
		}
	}

	items, err := s.CountWorkMemosByMonth(user.ID, "2026-08-01 00:00:00.000Z", "2026-09-01 00:00:00.000Z")
	if err != nil {
		t.Fatalf("count by month: %v", err)
	}

	want := map[string]int{"2026-08-01": 2, "2026-08-02": 1, "2026-08-21": 3, "2026-08-31": 3}
	if len(items) != len(want) {
		t.Fatalf("expected %d dates, got %d: %#v", len(want), len(items), items)
	}
	for i, item := range items {
		if item.Count != want[item.Date] {
			t.Fatalf("item %d date %s count = %d, want %d", i, item.Date, item.Count, want[item.Date])
		}
	}
}

func TestWorkMemoStoreCountByMonthUserIsolation(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)

	if _, err := s.CreateWorkMemo(userA.ID, CreateWorkMemoInput{Date: "2026-08-01", Content: "a1"}); err != nil {
		t.Fatalf("create a1: %v", err)
	}
	if _, err := s.CreateWorkMemo(userA.ID, CreateWorkMemoInput{Date: "2026-08-02", Content: "a2"}); err != nil {
		t.Fatalf("create a2: %v", err)
	}
	if _, err := s.CreateWorkMemo(userB.ID, CreateWorkMemoInput{Date: "2026-08-01", Content: "b1"}); err != nil {
		t.Fatalf("create b1: %v", err)
	}

	items, err := s.CountWorkMemosByMonth(userA.ID, "2026-08-01 00:00:00.000Z", "2026-09-01 00:00:00.000Z")
	if err != nil {
		t.Fatalf("count by month: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("userA expected 2 dates, got %#v", items)
	}
	for _, item := range items {
		if item.Count != 1 {
			t.Fatalf("userA date %s count = %d, want 1", item.Date, item.Count)
		}
	}
}

func TestWorkMemoStoreCountByMonthEmptyMonth(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	items, err := s.CountWorkMemosByMonth(user.ID, "2026-08-01 00:00:00.000Z", "2026-09-01 00:00:00.000Z")
	if err != nil {
		t.Fatalf("count by month: %v", err)
	}
	if items == nil || len(items) != 0 {
		t.Fatalf("expected empty slice, got %#v", items)
	}
}
