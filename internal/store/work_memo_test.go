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
