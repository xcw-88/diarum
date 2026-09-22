package store

import (
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func createSearchMemo(t *testing.T, s *Store, owner, date, content string, tags []string, status string) *WorkMemo {
	t.Helper()
	memo, err := s.CreateWorkMemo(owner, CreateWorkMemoInput{
		Date:    date,
		Content: content,
		Tags:    tags,
		Status:  status,
	})
	if err != nil {
		t.Fatalf("CreateWorkMemo(%s): %v", date, err)
	}
	return memo
}

func runWorkMemoSearch(t *testing.T, s *Store, owner string, query WorkMemoSearchQuery) ([]*WorkMemoSearchResult, int) {
	t.Helper()
	items, total, err := s.SearchWorkMemos(owner, query)
	if err != nil {
		t.Fatalf("SearchWorkMemos: %v", err)
	}
	return items, total
}

func workMemoResultIDs(items []*WorkMemoSearchResult) []string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return ids
}

func rawWorkMemoSearchText(t *testing.T, s *Store, id string) string {
	t.Helper()
	var text string
	if err := s.DB.QueryRow(`SELECT search_text FROM work_memos WHERE id = ?`, id).Scan(&text); err != nil {
		t.Fatalf("scan search_text: %v", err)
	}
	return text
}

func twoDigits(value int) string {
	return string([]byte{'0' + byte(value/10), '0' + byte(value%10)})
}

// ---------------------------------------------------------------------------
// extraction (task items 1-7)
// ---------------------------------------------------------------------------

func TestExtractWorkMemoSearchTextCases(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{
			name:    "1 plain paragraph",
			content: "<p>Steel platform inspection</p>",
			want:    "Steel platform inspection",
		},
		{
			name:    "2 multiple paragraphs normalize whitespace",
			content: "<p>Steel   platform</p>\n<p>  Valve\n\ncheck  </p>",
			want:    "Steel platform Valve check",
		},
		{
			name:    "3 html entities",
			content: "<p>Rock &amp; Roll &lt;tag&gt; &nbsp; done</p>",
			want:    "Rock & Roll <tag> done",
		},
		{
			name:    "4 chinese text",
			content: "<p>钢平台检查，阀门已关闭。</p>",
			want:    "钢平台检查，阀门已关闭。",
		},
		{
			name:    "5 image data-media-id and src are not searchable",
			content: `<p>Before</p><img src="/api/v1/media/med123/file" data-media-id="med123" alt="photo" class="memo-image" style="width:1px"><p>After</p>`,
			want:    "Before After",
		},
		{
			name:    "6 historical url-only image is not searchable",
			content: `<p>text</p><img src="https://images.example.test/legacy/photo.png"><p>more</p>`,
			want:    "text more",
		},
		{
			name:    "7 empty content",
			content: "",
			want:    "",
		},
		{
			name:    "blob image is not searchable",
			content: `<p>draft</p><img src="blob:http://localhost/9f8e7d">`,
			want:    "draft",
		},
		{
			name:    "tag names and attributes are not searchable",
			content: `<div class="note" data-note="secret" style="color:red"><span>visible</span></div>`,
			want:    "visible",
		},
		{
			name:    "script and style bodies are not searchable",
			content: `<p>keep</p><script>var secret = "leak";</script><style>.a{color:red}</style><p>also</p>`,
			want:    "keep also",
		},
		{
			name:    "inline marks never split a cjk word",
			content: "<p>钢<strong>平台</strong>阀门</p>",
			want:    "钢平台阀门",
		},
		{
			name:    "whitespace only content",
			content: "   \n\t  ",
			want:    "",
		},
		{
			name:    "image only content",
			content: `<img src="blob:abc">`,
			want:    "",
		},
		{
			name:    "unterminated markup keeps visible text",
			content: "<p>unclosed",
			want:    "unclosed",
		},
		{
			name:    "non breaking space is normalized",
			content: "<p>a&nbsp;&nbsp;b</p>",
			want:    "a b",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := extractWorkMemoSearchText(testCase.content); got != testCase.want {
				t.Fatalf("extractWorkMemoSearchText(%q) = %q, want %q", testCase.content, got, testCase.want)
			}
		})
	}
}

func TestExtractWorkMemoSearchTextNeverReturnsMarkup(t *testing.T) {
	content := `<div data-media-id="med1"><p>钢平台</p><img src="blob:x" data-uploading="true"></div>`
	text := extractWorkMemoSearchText(content)
	for _, forbidden := range []string{"<", ">", "div", "data-media-id", "blob", "med1", "src", "data-uploading"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("search text %q must not contain %q", text, forbidden)
		}
	}
}

// ---------------------------------------------------------------------------
// write path
// ---------------------------------------------------------------------------

func TestWorkMemoStoreDerivesSearchTextOnCreate(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	memo := createSearchMemo(t, s, user.ID, "2026-08-21", "<p>钢平台 <strong>阀门</strong>检查</p>", nil, "")

	if got := rawWorkMemoSearchText(t, s, memo.ID); got != "钢平台 阀门检查" {
		t.Fatalf("stored search_text = %q, want %q", got, "钢平台 阀门检查")
	}
}

func TestWorkMemoStoreRegeneratesSearchTextOnContentUpdate(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	memo := createSearchMemo(t, s, user.ID, "2026-08-21", "<p>first revision</p>", nil, "")

	content := "<p>second revision</p>"
	if _, err := s.UpdateWorkMemo(user.ID, memo.ID, UpdateWorkMemoInput{Content: &content}); err != nil {
		t.Fatalf("UpdateWorkMemo: %v", err)
	}
	if got := rawWorkMemoSearchText(t, s, memo.ID); got != "second revision" {
		t.Fatalf("search_text after content update = %q, want %q", got, "second revision")
	}

	// The stale text must no longer match.
	if _, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"first"}}); total != 0 {
		t.Fatalf("stale term still matched, total = %d", total)
	}
	if _, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"second"}}); total != 1 {
		t.Fatalf("new term total = %d, want 1", total)
	}
}

func TestWorkMemoStoreStatusAndPinUpdateLeavesSearchTextAlone(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	memo := createSearchMemo(t, s, user.ID, "2026-08-21", "<p>unchanged body</p>", nil, "")
	before := rawWorkMemoSearchText(t, s, memo.ID)

	status := WorkMemoStatusCompleted
	pinned := true
	if _, err := s.UpdateWorkMemo(user.ID, memo.ID, UpdateWorkMemoInput{Status: &status, IsPinned: &pinned}); err != nil {
		t.Fatalf("UpdateWorkMemo: %v", err)
	}
	if after := rawWorkMemoSearchText(t, s, memo.ID); after != before {
		t.Fatalf("search_text changed on a non-content update: %q -> %q", before, after)
	}
}

func TestWorkMemoStoreSearchTextCannotBeInjectedByCaller(t *testing.T) {
	// CreateWorkMemoInput has no search_text field and UpdateWorkMemoInput has
	// none either, so the only writer of the column is the extractor. This test
	// pins that the derived value is always recomputed from content.
	s := newTestStore(t)
	user := newTestUser(t, s)
	memo := createSearchMemo(t, s, user.ID, "2026-08-21", "<p>real body</p>", nil, "")

	status := WorkMemoStatusPending
	if _, err := s.UpdateWorkMemo(user.ID, memo.ID, UpdateWorkMemoInput{Status: &status}); err != nil {
		t.Fatalf("UpdateWorkMemo: %v", err)
	}
	if got := rawWorkMemoSearchText(t, s, memo.ID); got != "real body" {
		t.Fatalf("search_text = %q, want the derived %q", got, "real body")
	}
}

// ---------------------------------------------------------------------------
// search semantics (task items 8-26, store level)
// ---------------------------------------------------------------------------

func TestWorkMemoSearchSimpleAndChineseQuery(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01", "<p>steel platform inspection</p>", nil, "")
	createSearchMemo(t, s, user.ID, "2026-08-02", "<p>钢平台阀门检查</p>", nil, "")
	createSearchMemo(t, s, user.ID, "2026-08-03", "<p>unrelated note</p>", nil, "")

	items, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"platform"}})
	if total != 1 || len(items) != 1 {
		t.Fatalf("ascii query total = %d items = %d, want 1/1", total, len(items))
	}
	if items[0].Date != "2026-08-01 00:00:00.000Z" {
		t.Fatalf("date = %q", items[0].Date)
	}

	items, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"阀门"}})
	if total != 1 || len(items) != 1 {
		t.Fatalf("chinese query total = %d items = %d, want 1/1", total, len(items))
	}

	_, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"钢平台阀门检查"}})
	if total != 1 {
		t.Fatalf("full chinese phrase total = %d, want 1", total)
	}
}

func TestWorkMemoSearchMultiTermIsAnd(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01", "<p>钢平台检查</p><p>阀门已关闭</p>", nil, "")
	createSearchMemo(t, s, user.ID, "2026-08-02", "<p>钢平台检查</p>", nil, "")
	createSearchMemo(t, s, user.ID, "2026-08-03", "<p>阀门已关闭</p>", nil, "")

	items, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"钢平台", "阀门"}})
	if total != 1 || len(items) != 1 {
		t.Fatalf("AND query total = %d items = %d, want 1/1", total, len(items))
	}
	if items[0].Date != "2026-08-01 00:00:00.000Z" {
		t.Fatalf("AND matched the wrong memo: %q", items[0].Date)
	}

	_, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"钢平台", "missing"}})
	if total != 0 {
		t.Fatalf("AND with a missing term total = %d, want 0", total)
	}
}

func TestWorkMemoSearchPercentAndUnderscoreAreLiteral(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	percent := createSearchMemo(t, s, user.ID, "2026-08-01", "<p>progress 50% done</p>", nil, "")
	underscore := createSearchMemo(t, s, user.ID, "2026-08-02", "<p>tag_underscore here</p>", nil, "")
	createSearchMemo(t, s, user.ID, "2026-08-03", "<p>ordinary text</p>", nil, "")

	items, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"50%"}})
	if total != 1 || items[0].ID != percent.ID {
		t.Fatalf("literal %% match = %v (total %d), want only the percent memo", workMemoResultIDs(items), total)
	}

	// A bare "%" must be a literal percent sign, never a match-everything
	// wildcard.
	items, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"%"}})
	if total != 1 || items[0].ID != percent.ID {
		t.Fatalf("bare %% total = %d ids = %v, want only the percent memo", total, workMemoResultIDs(items))
	}

	items, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"_"}})
	if total != 1 || items[0].ID != underscore.ID {
		t.Fatalf("bare _ total = %d ids = %v, want only the underscore memo", total, workMemoResultIDs(items))
	}

	// A bare "_" must not behave as a single-character wildcard.
	if _, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"tag_here"}}); total != 0 {
		t.Fatalf("_ acted as a wildcard: total = %d, want 0", total)
	}

	// A bare "\" must be literal as well and must not break the ESCAPE clause.
	if _, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{`\`}}); total != 0 {
		t.Fatalf("backslash query total = %d, want 0", total)
	}
}

func TestWorkMemoSearchNoMatchReturnsEmptyResult(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01", "<p>something</p>", nil, "")

	items, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"nothing-matches-this"}})
	if total != 0 {
		t.Fatalf("total = %d, want 0", total)
	}
	if len(items) != 0 {
		t.Fatalf("items = %#v, want empty", items)
	}
}

func TestWorkMemoSearchDoesNotMatchImageIdentifiers(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01",
		`<p>进度说明</p><img src="/api/v1/media/med123abc/file" data-media-id="med123abc">`, nil, "")

	for _, term := range []string{"med123abc", "api", "media", "file", "src"} {
		if _, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{term}}); total != 0 {
			t.Fatalf("term %q matched an image identifier, total = %d", term, total)
		}
	}
	if _, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"进度说明"}}); total != 1 {
		t.Fatalf("visible text total = %d, want 1", total)
	}
}

func TestWorkMemoSearchScriptBodyIsNotSearchable(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01", `<p>visible</p><script>secretPayload()</script>`, nil, "")

	if _, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"secretPayload"}}); total != 0 {
		t.Fatalf("script body was searchable, total = %d", total)
	}
}

func TestWorkMemoSearchAsciiCaseInsensitive(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01", "<p>Steel Platform</p>", nil, "")

	// SQLite's default LIKE is case insensitive for ASCII; that behaviour is
	// kept so a lowercase query still finds capitalised text.
	if _, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"steel platform"}}); total != 1 {
		t.Fatalf("lowercase query total = %d, want 1", total)
	}
}

func TestWorkMemoSearchDateFilters(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01", "<p>shared keyword</p>", nil, "")
	createSearchMemo(t, s, user.ID, "2026-08-10", "<p>shared keyword</p>", nil, "")
	createSearchMemo(t, s, user.ID, "2026-08-20", "<p>shared keyword</p>", nil, "")

	terms := []string{"shared"}

	_, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: terms, DateFrom: "2026-08-10"})
	if total != 2 {
		t.Fatalf("date_from total = %d, want 2", total)
	}

	_, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: terms, DateTo: "2026-08-10"})
	if total != 2 {
		t.Fatalf("date_to total = %d, want 2", total)
	}

	// Both bounds are inclusive, so a range that starts and ends on a memo date
	// still returns that memo.
	items, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: terms, DateFrom: "2026-08-10", DateTo: "2026-08-10"})
	if total != 1 || len(items) != 1 {
		t.Fatalf("inclusive single day range total = %d items = %d, want 1/1", total, len(items))
	}
	if items[0].Date != "2026-08-10 00:00:00.000Z" {
		t.Fatalf("inclusive range date = %q", items[0].Date)
	}

	_, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: terms, DateFrom: "2026-08-02", DateTo: "2026-08-19"})
	if total != 1 {
		t.Fatalf("inner range total = %d, want 1", total)
	}

	// A date filter is a criterion on its own, without any text term.
	_, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{DateFrom: "2026-08-20", DateTo: "2026-08-20"})
	if total != 1 {
		t.Fatalf("date-only total = %d, want 1", total)
	}
}

func TestWorkMemoSearchStatusFilter(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01", "<p>shared</p>", nil, WorkMemoStatusNormal)
	createSearchMemo(t, s, user.ID, "2026-08-02", "<p>shared</p>", nil, WorkMemoStatusPending)
	createSearchMemo(t, s, user.ID, "2026-08-03", "<p>shared</p>", nil, WorkMemoStatusCompleted)

	for status, want := range map[string]int{
		WorkMemoStatusNormal:    1,
		WorkMemoStatusPending:   1,
		WorkMemoStatusCompleted: 1,
	} {
		_, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Status: status})
		if total != want {
			t.Fatalf("status %q total = %d, want %d", status, total, want)
		}
	}

	_, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}, Status: WorkMemoStatusPending})
	if total != 1 {
		t.Fatalf("status + q total = %d, want 1", total)
	}
	if _, _, err := s.SearchWorkMemos(user.ID, WorkMemoSearchQuery{Status: "archived"}); err == nil {
		t.Fatal("SearchWorkMemos should reject an unsupported status")
	}
}

func TestWorkMemoSearchSorting(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01", "<p>shared keyword</p>", nil, "")
	createSearchMemo(t, s, user.ID, "2026-08-20", "<p>shared keyword</p>", nil, "")
	createSearchMemo(t, s, user.ID, "2026-08-10", "<p>shared keyword</p>", nil, "")

	items, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}, Sort: WorkMemoSortDateDesc})
	if total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
	wantDesc := []string{"2026-08-20 00:00:00.000Z", "2026-08-10 00:00:00.000Z", "2026-08-01 00:00:00.000Z"}
	for i, want := range wantDesc {
		if items[i].Date != want {
			t.Fatalf("date_desc item %d = %q, want %q", i, items[i].Date, want)
		}
	}

	// An empty sort name defaults to date_desc.
	items, _ = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}})
	if items[0].Date != wantDesc[0] {
		t.Fatalf("default sort first date = %q, want %q", items[0].Date, wantDesc[0])
	}

	items, _ = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}, Sort: WorkMemoSortDateAsc})
	for i, want := range []string{"2026-08-01 00:00:00.000Z", "2026-08-10 00:00:00.000Z", "2026-08-20 00:00:00.000Z"} {
		if items[i].Date != want {
			t.Fatalf("date_asc item %d = %q, want %q", i, items[i].Date, want)
		}
	}

	if _, _, err := s.SearchWorkMemos(user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}, Sort: "relevance"}); err == nil {
		t.Fatal("SearchWorkMemos should reject an unsupported sort")
	}
}

func TestWorkMemoSearchStableTieOrdering(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	// Three memos on the same date exercise the position tie-breaker, and
	// pinning the middle one must move it to the front of that date.
	first := createSearchMemo(t, s, user.ID, "2026-08-21", "<p>shared keyword</p>", nil, "")
	second := createSearchMemo(t, s, user.ID, "2026-08-21", "<p>shared keyword</p>", nil, "")
	third := createSearchMemo(t, s, user.ID, "2026-08-21", "<p>shared keyword</p>", nil, "")

	pinned := true
	if _, err := s.UpdateWorkMemo(user.ID, second.ID, UpdateWorkMemoInput{IsPinned: &pinned}); err != nil {
		t.Fatalf("pin: %v", err)
	}

	firstRun, _ := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}})
	want := []string{second.ID, first.ID, third.ID}
	for i, id := range want {
		if firstRun[i].ID != id {
			t.Fatalf("pinned-first order item %d = %s, want %s", i, firstRun[i].ID, id)
		}
	}

	// Repeating the same query must return the identical order.
	secondRun, _ := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}})
	for i := range want {
		if secondRun[i].ID != firstRun[i].ID {
			t.Fatalf("order is not stable at item %d: %s vs %s", i, secondRun[i].ID, firstRun[i].ID)
		}
	}
}

func TestWorkMemoSearchPaginationIsStable(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)

	total := 25
	for i := 0; i < total; i++ {
		date := "2026-08-" + twoDigits(i+1)
		createSearchMemo(t, s, user.ID, date, "<p>shared keyword</p>", nil, "")
	}

	seen := make(map[string]bool, total)
	var boundaries []string

	pageSize := 10
	for page := 1; page <= 3; page++ {
		items, count := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{
			Terms:    []string{"shared"},
			Page:     page,
			PageSize: pageSize,
		})
		if count != total {
			t.Fatalf("page %d total = %d, want %d", page, count, total)
		}
		wantLen := pageSize
		if page == 3 {
			wantLen = 5
		}
		if len(items) != wantLen {
			t.Fatalf("page %d items = %d, want %d", page, len(items), wantLen)
		}
		for _, item := range items {
			if seen[item.ID] {
				t.Fatalf("item %s appeared on more than one page", item.ID)
			}
			seen[item.ID] = true
			boundaries = append(boundaries, item.Date)
		}
	}

	if len(seen) != total {
		t.Fatalf("paged results covered %d of %d memos", len(seen), total)
	}
	// date_desc across page boundaries: the whole sequence must stay sorted.
	for i := 1; i < len(boundaries); i++ {
		if boundaries[i-1] < boundaries[i] {
			t.Fatalf("paging broke date_desc at index %d: %q then %q", i, boundaries[i-1], boundaries[i])
		}
	}

	// A page beyond the end is empty but still reports the real total.
	items, count := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}, Page: 99, PageSize: pageSize})
	if count != total || len(items) != 0 {
		t.Fatalf("out of range page total = %d items = %d, want %d/0", count, len(items), total)
	}
}

func TestWorkMemoSearchPageSizeIsClampedInternally(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	createSearchMemo(t, s, user.ID, "2026-08-01", "<p>shared</p>", nil, "")

	// The HTTP layer rejects out-of-range page sizes; the Store additionally
	// clamps so an internal caller cannot build an unbounded or negative page.
	items, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}, PageSize: 1000})
	if total != 1 || len(items) != 1 {
		t.Fatalf("oversized page_size total = %d items = %d", total, len(items))
	}
	items, _ = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"shared"}, Page: -5, PageSize: -1})
	if len(items) != 1 {
		t.Fatalf("negative paging returned %d items, want 1", len(items))
	}
}

func TestWorkMemoSearchRequiresOwner(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := s.SearchWorkMemos("", WorkMemoSearchQuery{Terms: []string{"x"}}); err == nil {
		t.Fatal("SearchWorkMemos should reject an empty owner")
	}
}

func TestWorkMemoSearchOwnerIsolation(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)

	sharedKeyword := "shared keyword"
	a1 := createSearchMemo(t, s, userA.ID, "2026-08-01", "<p>"+sharedKeyword+" A1</p>", nil, "")
	a2 := createSearchMemo(t, s, userA.ID, "2026-08-02", "<p>"+sharedKeyword+" A2</p>", nil, "")
	createSearchMemo(t, s, userB.ID, "2026-08-01", "<p>"+sharedKeyword+" B1</p>", nil, "")
	createSearchMemo(t, s, userB.ID, "2026-08-02", "<p>"+sharedKeyword+" B2</p>", nil, "")
	createSearchMemo(t, s, userB.ID, "2026-08-03", "<p>"+sharedKeyword+" B3</p>", nil, "")

	items, total := runWorkMemoSearch(t, s, userA.ID, WorkMemoSearchQuery{Terms: []string{"shared"}})
	if total != 2 {
		t.Fatalf("user A total = %d, want 2", total)
	}
	if len(items) != 2 {
		t.Fatalf("user A items = %d, want 2", len(items))
	}
	allowed := map[string]bool{a1.ID: true, a2.ID: true}
	for _, item := range items {
		if !allowed[item.ID] {
			t.Fatalf("user A received a memo it does not own: %s", item.ID)
		}
	}

	// The count query must be isolated too: total must never include B's rows.
	itemsB, totalB := runWorkMemoSearch(t, s, userB.ID, WorkMemoSearchQuery{Terms: []string{"shared"}})
	if totalB != 3 || len(itemsB) != 3 {
		t.Fatalf("user B total = %d items = %d, want 3/3", totalB, len(itemsB))
	}
}

func TestWorkMemoSearchOwnerIsolationDoesNotLeakMetadata(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)

	createSearchMemo(t, s, userA.ID, "2026-08-01", "<p>only mine</p>", []string{"alpha"}, WorkMemoStatusCompleted)
	createSearchMemo(t, s, userB.ID, "2026-08-02", "<p>shared keyword secret</p>", []string{"beta"}, WorkMemoStatusPending)

	// None of A's filter combinations may observe B's row.
	for _, query := range []WorkMemoSearchQuery{
		{Terms: []string{"secret"}},
		{Tag: "beta"},
		{Status: WorkMemoStatusPending},
		{DateFrom: "2026-08-02", DateTo: "2026-08-02"},
	} {
		items, total := runWorkMemoSearch(t, s, userA.ID, query)
		if total != 0 || len(items) != 0 {
			t.Fatalf("cross-owner leak for %+v: total = %d items = %v", query, total, workMemoResultIDs(items))
		}
	}
}

// ---------------------------------------------------------------------------
// tag filtering (task items 33-36)
// ---------------------------------------------------------------------------

func TestWorkMemoSearchExactTagFilter(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	tagged := createSearchMemo(t, s, user.ID, "2026-08-01", "<p>tagged memo</p>", []string{"钢平台", "阀门"}, "")
	createSearchMemo(t, s, user.ID, "2026-08-02", "<p>other memo</p>", []string{"管道"}, "")

	items, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Tag: "钢平台"})
	if total != 1 || items[0].ID != tagged.ID {
		t.Fatalf("exact tag total = %d items = %v, want the tagged memo", total, workMemoResultIDs(items))
	}

	_, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Tag: "钢"})
	if total != 0 {
		t.Fatalf("tag substring matched %d rows, want 0 (tags are exact)", total)
	}

	_, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Tag: "阀门"})
	if total != 1 {
		t.Fatalf("second tag total = %d, want 1", total)
	}

	_, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Tag: "钢平台", Terms: []string{"tagged"}})
	if total != 1 {
		t.Fatalf("tag + q AND total = %d, want 1", total)
	}

	_, total = runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Tag: "钢平台", Terms: []string{"missing"}})
	if total != 0 {
		t.Fatalf("tag + non-matching q total = %d, want 0", total)
	}
}

func TestWorkMemoSearchTagFilterOwnerIsolation(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	createSearchMemo(t, s, userA.ID, "2026-08-01", "<p>a</p>", []string{"shared-tag"}, "")
	createSearchMemo(t, s, userB.ID, "2026-08-02", "<p>b</p>", []string{"shared-tag"}, "")

	items, total := runWorkMemoSearch(t, s, userA.ID, WorkMemoSearchQuery{Tag: "shared-tag"})
	if total != 1 || len(items) != 1 {
		t.Fatalf("tag owner isolation total = %d items = %d, want 1/1", total, len(items))
	}
}

func TestWorkMemoSearchToleratesMalformedTagsValue(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	memo := createSearchMemo(t, s, user.ID, "2026-08-01", "<p>body text</p>", []string{"valid"}, "")

	// A row whose tags value is not valid JSON must not abort the whole query.
	if _, err := s.DB.Exec(`UPDATE work_memos SET tags = 'not-json' WHERE id = ?`, memo.ID); err != nil {
		t.Fatalf("corrupt tags: %v", err)
	}

	items, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Tag: "valid"})
	if total != 0 || len(items) != 0 {
		t.Fatalf("malformed tags row total = %d items = %d, want 0/0", total, len(items))
	}
	// Text search on the same table must still work.
	if _, total := runWorkMemoSearch(t, s, user.ID, WorkMemoSearchQuery{Terms: []string{"body"}}); total != 1 {
		t.Fatalf("text search total = %d, want 1", total)
	}
}

// ---------------------------------------------------------------------------
// migration (task items 30-32)
// ---------------------------------------------------------------------------

// buildPreSearchDatabase creates a database that looks like one written before
// Work Memo search existed: work_memos has no search_text column.
func buildPreSearchDatabase(t *testing.T, dataDir string) {
	t.Helper()

	db, err := openSQLite(filepath.Join(dataDir, DatabaseName))
	if err != nil {
		t.Fatalf("openSQLite: %v", err)
	}
	defer db.Close()

	if err := createSchema(db); err != nil {
		t.Fatalf("createSchema: %v", err)
	}
	if _, err := db.Exec(`ALTER TABLE work_memos DROP COLUMN search_text`); err != nil {
		t.Fatalf("drop search_text to simulate a pre-search database: %v", err)
	}

	owner := "legacy-owner"
	if _, err := db.Exec(
		`INSERT INTO users(avatar, created, email, emailVisibility, id, lastLoginAlertSentAt, lastResetSentAt, lastVerificationSentAt, name, passwordHash, tokenKey, updated, username, verified)
		 VALUES('', ?, '', 0, ?, '', '', '', 'legacy', 'hash', 'token', ?, 'legacy', 0)`,
		nowString(), owner, nowString(),
	); err != nil {
		t.Fatalf("insert legacy user: %v", err)
	}

	// A distinctive updated value proves the backfill never touches it.
	const legacyUpdated = "2020-01-01 00:00:00.000Z"
	rows := []struct {
		id      string
		date    string
		content string
		tags    string
		status  string
	}{
		{"legacy-plain", "2026-08-01 00:00:00.000Z", "<p>钢平台阀门检查</p>", `["alpha"]`, "normal"},
		{"legacy-empty", "2026-08-02 00:00:00.000Z", "", `[]`, "pending"},
		{"legacy-image", "2026-08-03 00:00:00.000Z", `<p>visible only</p><img src="/api/v1/media/medLegacy/file" data-media-id="medLegacy">`, `["beta"]`, "completed"},
	}
	for index, row := range rows {
		if _, err := db.Exec(
			`INSERT INTO work_memos(id, owner, date, content, status, is_pinned, position, tags, created, updated)
			 VALUES(?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
			row.id, owner, row.date, row.content, row.status, index, row.tags, legacyUpdated, legacyUpdated,
		); err != nil {
			t.Fatalf("insert legacy memo %s: %v", row.id, err)
		}
	}

	// Media and an attachment association must survive the migration untouched.
	if _, err := db.Exec(
		`INSERT INTO media(alt, created, file, id, name, owner, updated, diary) VALUES('', ?, 'medLegacy.png', 'medLegacy', 'photo', ?, ?, '[]')`,
		nowString(), owner, nowString(),
	); err != nil {
		t.Fatalf("insert legacy media: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO work_memo_media(created, id, media_id, memo_id, owner, position) VALUES(?, 'legacy-assoc', 'medLegacy', 'legacy-image', ?, 0)`,
		nowString(), owner,
	); err != nil {
		t.Fatalf("insert legacy association: %v", err)
	}
}

func TestOpenMigratesAndBackfillsWorkMemoSearchText(t *testing.T) {
	dataDir := t.TempDir()
	buildPreSearchDatabase(t, dataDir)

	s, err := Open(dataDir)
	if err != nil {
		t.Fatalf("Open after migration: %v", err)
	}
	defer s.Close()

	// The column exists and every row that has visible text got a value.
	if has, err := tableHasColumn(s.DB, "work_memos", "search_text"); err != nil || !has {
		t.Fatalf("search_text column present = %v, err = %v", has, err)
	}
	if got := rawWorkMemoSearchText(t, s, "legacy-plain"); got != "钢平台阀门检查" {
		t.Fatalf("backfilled plain memo = %q", got)
	}
	if got := rawWorkMemoSearchText(t, s, "legacy-empty"); got != "" {
		t.Fatalf("empty memo search_text = %q, want empty", got)
	}
	if got := rawWorkMemoSearchText(t, s, "legacy-image"); got != "visible only" {
		t.Fatalf("image memo search_text = %q, want %q", got, "visible only")
	}

	owner := "legacy-owner"

	// The backfilled rows are searchable through the public search path.
	items, total := runWorkMemoSearch(t, s, owner, WorkMemoSearchQuery{Terms: []string{"钢平台"}})
	if total != 1 || items[0].ID != "legacy-plain" {
		t.Fatalf("search after migration total = %d items = %v", total, workMemoResultIDs(items))
	}

	// Only visible text is searchable: image identifiers must not match.
	for _, term := range []string{"medLegacy", "api", "visible"} {
		_, total := runWorkMemoSearch(t, s, owner, WorkMemoSearchQuery{Terms: []string{term}})
		want := 0
		if term == "visible" {
			want = 1
		}
		if total != want {
			t.Fatalf("term %q total = %d, want %d", term, total, want)
		}
	}

	// Backfilled rows are filterable through their existing metadata.
	if _, total := runWorkMemoSearch(t, s, owner, WorkMemoSearchQuery{Tag: "alpha"}); total != 1 {
		t.Fatalf("backfilled tag filter total = %d, want 1", total)
	}
	if _, total := runWorkMemoSearch(t, s, owner, WorkMemoSearchQuery{Status: WorkMemoStatusPending}); total != 1 {
		t.Fatalf("backfilled status filter total = %d, want 1", total)
	}
}

func TestOpenBackfillDoesNotTouchUpdatedOrAttachments(t *testing.T) {
	dataDir := t.TempDir()
	buildPreSearchDatabase(t, dataDir)

	s, err := Open(dataDir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	var updated string
	if err := s.DB.QueryRow(`SELECT updated FROM work_memos WHERE id = 'legacy-plain'`).Scan(&updated); err != nil {
		t.Fatalf("scan updated: %v", err)
	}
	if updated != "2020-01-01 00:00:00.000Z" {
		t.Fatalf("backfill changed updated to %q", updated)
	}

	var associations int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM work_memo_media WHERE memo_id = 'legacy-image' AND media_id = 'medLegacy'`).Scan(&associations); err != nil {
		t.Fatalf("count associations: %v", err)
	}
	if associations != 1 {
		t.Fatalf("associations after migration = %d, want 1", associations)
	}

	var mediaCount int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM media WHERE id = 'medLegacy'`).Scan(&mediaCount); err != nil {
		t.Fatalf("count media: %v", err)
	}
	if mediaCount != 1 {
		t.Fatalf("media rows after migration = %d, want 1", mediaCount)
	}
}

func TestOpenWorkMemoSearchTextMigrationIsIdempotent(t *testing.T) {
	dataDir := t.TempDir()
	buildPreSearchDatabase(t, dataDir)

	first, err := Open(dataDir)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	firstText := rawWorkMemoSearchText(t, first, "legacy-plain")
	if err := first.Close(); err != nil {
		t.Fatalf("close first: %v", err)
	}

	second, err := Open(dataDir)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer second.Close()

	if got := rawWorkMemoSearchText(t, second, "legacy-plain"); got != firstText {
		t.Fatalf("second Open changed search_text: %q -> %q", firstText, got)
	}

	// The pass is recorded, so a normal startup does not rescan every body.
	marker, err := getMeta(second.DB, workMemoSearchTextBackfillKey)
	if err != nil || marker != "done" {
		t.Fatalf("backfill marker = %q, err = %v, want \"done\"", marker, err)
	}

	if err := ensureWorkMemoSearchText(second.DB); err != nil {
		t.Fatalf("ensureWorkMemoSearchText on an already migrated database: %v", err)
	}
}

func TestEnsureWorkMemoSearchTextAddsColumnOnlyOnce(t *testing.T) {
	s := newTestStore(t)
	for i := 0; i < 3; i++ {
		if err := ensureWorkMemoSearchText(s.DB); err != nil {
			t.Fatalf("ensureWorkMemoSearchText run %d: %v", i, err)
		}
	}
}
