package store

import (
	"database/sql"
	"errors"
	"sort"
	"testing"
	"time"
)

func TestWorkMemoMediaCreateAndPosition(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	memoA := createWorkMemoMediaTestMemo(t, s, user.ID, "memo-a")
	memoB := createWorkMemoMediaTestMemo(t, s, user.ID, "memo-b")
	media := []*Media{
		createWorkMemoMediaTestMedia(t, s, user.ID, "first.png"),
		createWorkMemoMediaTestMedia(t, s, user.ID, "second.png"),
		createWorkMemoMediaTestMedia(t, s, user.ID, "third.png"),
	}

	associations := make([]*WorkMemoMedia, 0, len(media))
	for i, item := range media {
		association, err := s.CreateWorkMemoMedia(user.ID, memoA.ID, item.ID)
		if err != nil {
			t.Fatalf("CreateWorkMemoMedia %d: %v", i, err)
		}
		if association.ID == "" {
			t.Fatalf("association %d has empty id", i)
		}
		if association.Owner != user.ID || association.MemoID != memoA.ID || association.MediaID != item.ID {
			t.Fatalf("association %d fields = %#v", i, association)
		}
		if association.Position != i {
			t.Fatalf("association %d position = %d, want %d", i, association.Position, i)
		}
		if _, err := time.Parse("2006-01-02 15:04:05.000Z", association.Created); err != nil {
			t.Fatalf("association %d created = %q: %v", i, association.Created, err)
		}
		associations = append(associations, association)
	}

	listed, err := s.ListWorkMemoMedia(user.ID, memoA.ID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia memo A: %v", err)
	}
	if len(listed) != len(associations) {
		t.Fatalf("memo A list length = %d, want %d", len(listed), len(associations))
	}
	for i := range listed {
		if listed[i].ID != associations[i].ID || listed[i].Position != i {
			t.Fatalf("memo A list item %d = %#v, want id=%s position=%d", i, listed[i], associations[i].ID, i)
		}
	}

	reused, err := s.CreateWorkMemoMedia(user.ID, memoB.ID, media[0].ID)
	if err != nil {
		t.Fatalf("reuse media in memo B: %v", err)
	}
	if reused.Position != 0 {
		t.Fatalf("memo B first position = %d, want 0", reused.Position)
	}
}

func TestWorkMemoMediaPositionAppendsAfterMax(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	memo := createWorkMemoMediaTestMemo(t, s, user.ID, "memo")

	first, err := s.CreateWorkMemoMedia(user.ID, memo.ID, createWorkMemoMediaTestMedia(t, s, user.ID, "first.png").ID)
	if err != nil {
		t.Fatalf("create first association: %v", err)
	}
	second, err := s.CreateWorkMemoMedia(user.ID, memo.ID, createWorkMemoMediaTestMedia(t, s, user.ID, "second.png").ID)
	if err != nil {
		t.Fatalf("create second association: %v", err)
	}
	if _, err := s.DB.Exec(`UPDATE work_memo_media SET position = 2 WHERE id = ?`, second.ID); err != nil {
		t.Fatalf("create position gap: %v", err)
	}

	third, err := s.CreateWorkMemoMedia(user.ID, memo.ID, createWorkMemoMediaTestMedia(t, s, user.ID, "third.png").ID)
	if err != nil {
		t.Fatalf("create third association: %v", err)
	}
	if first.Position != 0 || third.Position != 3 {
		t.Fatalf("positions first/third = %d/%d, want 0/3", first.Position, third.Position)
	}
}

func TestWorkMemoMediaOwnershipAndListIsolation(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	memoA := createWorkMemoMediaTestMemo(t, s, userA.ID, "memo-a")
	memoB := createWorkMemoMediaTestMemo(t, s, userB.ID, "memo-b")
	mediaA := createWorkMemoMediaTestMedia(t, s, userA.ID, "a.png")
	mediaB := createWorkMemoMediaTestMedia(t, s, userB.ID, "b.png")

	associationA, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, mediaA.ID)
	if err != nil {
		t.Fatalf("create association A: %v", err)
	}
	associationB, err := s.CreateWorkMemoMedia(userB.ID, memoB.ID, mediaB.ID)
	if err != nil {
		t.Fatalf("create association B: %v", err)
	}

	tests := []struct {
		name    string
		owner   string
		memoID  string
		mediaID string
	}{
		{name: "owner cannot use another owner's memo", owner: userB.ID, memoID: memoA.ID, mediaID: mediaB.ID},
		{name: "owner cannot use another owner's media", owner: userA.ID, memoID: memoA.ID, mediaID: mediaB.ID},
		{name: "memo and media owners must match", owner: userB.ID, memoID: memoA.ID, mediaID: mediaA.ID},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := s.CreateWorkMemoMedia(test.owner, test.memoID, test.mediaID); !errors.Is(err, sql.ErrNoRows) {
				t.Fatalf("CreateWorkMemoMedia error = %v, want sql.ErrNoRows", err)
			}
		})
	}

	assertWorkMemoMediaListIDs(t, s, userA.ID, memoA.ID, []string{associationA.ID})
	assertWorkMemoMediaListIDs(t, s, userB.ID, memoB.ID, []string{associationB.ID})
	assertWorkMemoMediaListIDs(t, s, userA.ID, memoB.ID, nil)
	assertWorkMemoMediaListIDs(t, s, userB.ID, memoA.ID, nil)

	var total int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM work_memo_media`).Scan(&total); err != nil {
		t.Fatalf("count associations: %v", err)
	}
	if total != 2 {
		t.Fatalf("association count = %d, want 2", total)
	}
}

func TestWorkMemoMediaListHasStableTieBreakOrder(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	memo := createWorkMemoMediaTestMemo(t, s, user.ID, "memo")

	ids := make([]string, 0, 3)
	for _, filename := range []string{"one.png", "two.png", "three.png"} {
		media := createWorkMemoMediaTestMedia(t, s, user.ID, filename)
		association, err := s.CreateWorkMemoMedia(user.ID, memo.ID, media.ID)
		if err != nil {
			t.Fatalf("create %s association: %v", filename, err)
		}
		ids = append(ids, association.ID)
	}

	if _, err := s.DB.Exec(
		`UPDATE work_memo_media SET position = 0, created = ? WHERE memo_id = ?`,
		"2026-08-22 00:00:00.000Z", memo.ID,
	); err != nil {
		t.Fatalf("make positions tie: %v", err)
	}
	sort.Strings(ids)
	assertWorkMemoMediaListIDs(t, s, user.ID, memo.ID, ids)
}

func TestWorkMemoMediaRejectsDuplicateAssociation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	memo := createWorkMemoMediaTestMemo(t, s, user.ID, "memo")
	media := createWorkMemoMediaTestMedia(t, s, user.ID, "photo.png")

	if _, err := s.CreateWorkMemoMedia(user.ID, memo.ID, media.ID); err != nil {
		t.Fatalf("create association: %v", err)
	}
	if _, err := s.CreateWorkMemoMedia(user.ID, memo.ID, media.ID); err == nil {
		t.Fatal("duplicate CreateWorkMemoMedia succeeded")
	}

	var count int
	if err := s.DB.QueryRow(
		`SELECT COUNT(*) FROM work_memo_media WHERE memo_id = ? AND media_id = ?`,
		memo.ID, media.ID,
	).Scan(&count); err != nil {
		t.Fatalf("count duplicate association: %v", err)
	}
	if count != 1 {
		t.Fatalf("duplicate association count = %d, want 1", count)
	}
}

func TestDeleteWorkMemoMediaAssociationOnly(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	memoA := createWorkMemoMediaTestMemo(t, s, userA.ID, "memo-a")
	memoB := createWorkMemoMediaTestMemo(t, s, userA.ID, "memo-b")
	media := createWorkMemoMediaTestMedia(t, s, userA.ID, "shared.png")

	associationA, err := s.CreateWorkMemoMedia(userA.ID, memoA.ID, media.ID)
	if err != nil {
		t.Fatalf("create association A: %v", err)
	}
	associationB, err := s.CreateWorkMemoMedia(userA.ID, memoB.ID, media.ID)
	if err != nil {
		t.Fatalf("create association B: %v", err)
	}

	if err := s.DeleteWorkMemoMediaAssociation(userB.ID, memoA.ID, associationA.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("other owner delete error = %v, want sql.ErrNoRows", err)
	}
	if err := s.DeleteWorkMemoMediaAssociation(userA.ID, memoB.ID, associationA.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("other memo delete error = %v, want sql.ErrNoRows", err)
	}
	if err := s.DeleteWorkMemoMediaAssociation(userA.ID, memoA.ID, associationA.ID); err != nil {
		t.Fatalf("delete association A: %v", err)
	}

	assertWorkMemoMediaListIDs(t, s, userA.ID, memoA.ID, nil)
	assertWorkMemoMediaListIDs(t, s, userA.ID, memoB.ID, []string{associationB.ID})
	if _, err := s.GetMedia(media.ID, userA.ID); err != nil {
		t.Fatalf("shared media was deleted: %v", err)
	}
}

func TestWorkMemoMediaParentDeletesCascadeToAssociation(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	media := createWorkMemoMediaTestMedia(t, s, user.ID, "shared.png")
	memoA := createWorkMemoMediaTestMemo(t, s, user.ID, "memo-a")
	associationA, err := s.CreateWorkMemoMedia(user.ID, memoA.ID, media.ID)
	if err != nil {
		t.Fatalf("create association A: %v", err)
	}

	if err := s.DeleteWorkMemo(memoA.ID, user.ID); err != nil {
		t.Fatalf("delete memo A: %v", err)
	}
	assertWorkMemoMediaAssociationMissing(t, s, associationA.ID)
	if _, err := s.GetMedia(media.ID, user.ID); err != nil {
		t.Fatalf("deleting memo deleted media: %v", err)
	}

	memoB := createWorkMemoMediaTestMemo(t, s, user.ID, "memo-b")
	associationB, err := s.CreateWorkMemoMedia(user.ID, memoB.ID, media.ID)
	if err != nil {
		t.Fatalf("create association B: %v", err)
	}
	if err := s.DeleteMedia(media.ID, user.ID); err != nil {
		t.Fatalf("delete media: %v", err)
	}
	assertWorkMemoMediaAssociationMissing(t, s, associationB.ID)
}

func createWorkMemoMediaTestMemo(t *testing.T, s *Store, owner, content string) *WorkMemo {
	t.Helper()
	memo, err := s.CreateWorkMemo(owner, CreateWorkMemoInput{Date: "2026-08-22", Content: content})
	if err != nil {
		t.Fatalf("CreateWorkMemo %s: %v", content, err)
	}
	return memo
}

func createWorkMemoMediaTestMedia(t *testing.T, s *Store, owner, filename string) *Media {
	t.Helper()
	media, err := s.CreateMedia(owner, filename, filename, "", nil)
	if err != nil {
		t.Fatalf("CreateMedia %s: %v", filename, err)
	}
	return media
}

func assertWorkMemoMediaListIDs(t *testing.T, s *Store, owner, memoID string, want []string) {
	t.Helper()
	items, err := s.ListWorkMemoMedia(owner, memoID)
	if err != nil {
		t.Fatalf("ListWorkMemoMedia: %v", err)
	}
	if len(items) != len(want) {
		t.Fatalf("ListWorkMemoMedia ids length = %d, want %d: %#v", len(items), len(want), items)
	}
	for i := range items {
		if items[i].ID != want[i] {
			t.Fatalf("ListWorkMemoMedia id %d = %s, want %s", i, items[i].ID, want[i])
		}
	}
}

func assertWorkMemoMediaAssociationMissing(t *testing.T, s *Store, associationID string) {
	t.Helper()
	var count int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM work_memo_media WHERE id = ?`, associationID).Scan(&count); err != nil {
		t.Fatalf("count association %s: %v", associationID, err)
	}
	if count != 0 {
		t.Fatalf("association %s still exists", associationID)
	}
}
