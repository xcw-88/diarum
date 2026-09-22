package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/labstack/echo/v5"

	"github.com/songtianlun/diarum/internal/store"
)

const workMemoSearchPath = "/api/v1/work-memos/search"

func searchWorkMemoHTTP(t *testing.T, e *echo.Echo, rawQuery string) map[string]any {
	t.Helper()
	path := workMemoSearchPath
	if rawQuery != "" {
		path += "?" + rawQuery
	}
	rec := performRequest(t, e, http.MethodGet, path, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d body = %s", path, rec.Code, rec.Body.String())
	}
	return decodeJSONBody(t, rec)
}

func searchStatus(t *testing.T, e *echo.Echo, rawQuery string) int {
	t.Helper()
	path := workMemoSearchPath
	if rawQuery != "" {
		path += "?" + rawQuery
	}
	return performRequest(t, e, http.MethodGet, path, nil, nil).Code
}

func searchItemMaps(t *testing.T, payload map[string]any) []map[string]any {
	t.Helper()
	raw, ok := payload["items"].([]any)
	if !ok {
		t.Fatalf("items is not a JSON array: %#v", payload["items"])
	}
	items := make([]map[string]any, len(raw))
	for i, item := range raw {
		asMap, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("items[%d] is not an object: %#v", i, item)
		}
		items[i] = asMap
	}
	return items
}

func searchTotals(t *testing.T, payload map[string]any) (int, int, int, int) {
	t.Helper()
	page, _ := payload["page"].(float64)
	pageSize, _ := payload["page_size"].(float64)
	total, _ := payload["total"].(float64)
	totalPages, _ := payload["total_pages"].(float64)
	return int(page), int(pageSize), int(total), int(totalPages)
}

func countWorkMemoRows(t *testing.T, s *store.Store) (int, int) {
	t.Helper()
	var memos, associations int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM work_memos`).Scan(&memos); err != nil {
		t.Fatalf("count work_memos: %v", err)
	}
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM work_memo_media`).Scan(&associations); err != nil {
		t.Fatalf("count work_memo_media: %v", err)
	}
	return memos, associations
}

// ---------------------------------------------------------------------------
// routing and response shape
// ---------------------------------------------------------------------------

func TestWorkMemoSearchRouteIsNotShadowedByIDRoute(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-21", "<p>searchable body</p>")

	// "/search" is registered alongside the other static paths, so it must not
	// be captured by GET /:id (which would answer "Work memo not found").
	payload := searchWorkMemoHTTP(t, e, "q=searchable")
	if _, ok := payload["items"]; !ok {
		t.Fatalf("response is not a search payload: %#v", payload)
	}
}

func TestWorkMemoSearchResponseShape(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemo(t, e, "2026-08-21", "<p>钢平台阀门检查</p>", []string{"alpha", "beta"})

	payload := searchWorkMemoHTTP(t, e, "q=阀门")
	items := searchItemMaps(t, payload)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}

	for _, key := range []string{"id", "date", "snippet", "status", "is_pinned", "tags", "position"} {
		if _, ok := items[0][key]; !ok {
			t.Fatalf("item is missing %q: %#v", key, items[0])
		}
	}

	// A search response must never carry full HTML content or an owner field.
	for _, forbidden := range []string{"content", "owner", "search_text"} {
		if _, ok := items[0][forbidden]; ok {
			t.Fatalf("item must not expose %q: %#v", forbidden, items[0])
		}
	}

	if items[0]["date"] != "2026-08-21" {
		t.Fatalf("date = %#v, want the API date-only format", items[0]["date"])
	}
	if items[0]["snippet"] != "钢平台阀门检查" {
		t.Fatalf("snippet = %#v", items[0]["snippet"])
	}
	tags, _ := items[0]["tags"].([]any)
	if len(tags) != 2 || tags[0] != "alpha" || tags[1] != "beta" {
		t.Fatalf("tags = %#v", items[0]["tags"])
	}

	page, pageSize, total, totalPages := searchTotals(t, payload)
	if page != 1 || pageSize != 20 || total != 1 || totalPages != 1 {
		t.Fatalf("paging = %d/%d %d %d, want 1/20 1 1", page, pageSize, total, totalPages)
	}
}

// ---------------------------------------------------------------------------
// validation (task items 17, 18, 20, 24, 26)
// ---------------------------------------------------------------------------

func TestWorkMemoSearchRejectsEmptyCriteria(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-21", "<p>body</p>")

	// The endpoint must not become a timeline/list-all API.
	for _, rawQuery := range []string{
		"",
		"page=1&page_size=20&sort=date_desc",
		"q=",
		"q=%20%20",
		"tag=",
		"status=",
	} {
		if code := searchStatus(t, e, rawQuery); code != http.StatusBadRequest {
			t.Fatalf("GET ?%s status = %d, want 400", rawQuery, code)
		}
	}
}

func TestWorkMemoSearchRejectsInvalidDates(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	for _, rawQuery := range []string{
		"date_from=2026-13-40",
		"date_from=not-a-date",
		"date_from=2026-08-01T00:00:00Z",
		"date_to=2026-02-30",
		"date_to=nope",
	} {
		if code := searchStatus(t, e, rawQuery); code != http.StatusBadRequest {
			t.Fatalf("GET ?%s status = %d, want 400", rawQuery, code)
		}
	}

	// date_from must not be after date_to.
	if code := searchStatus(t, e, "date_from=2026-08-20&date_to=2026-08-01"); code != http.StatusBadRequest {
		t.Fatalf("reversed range status = %d, want 400", code)
	}

	// Equal bounds are a valid one-day range.
	if code := searchStatus(t, e, "date_from=2026-08-01&date_to=2026-08-01"); code != http.StatusOK {
		t.Fatalf("equal bounds status = %d, want 200", code)
	}
}

func TestWorkMemoSearchRejectsInvalidStatus(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	for _, rawQuery := range []string{"status=archived", "status=NORMAL", "status=done"} {
		if code := searchStatus(t, e, rawQuery); code != http.StatusBadRequest {
			t.Fatalf("GET ?%s status = %d, want 400", rawQuery, code)
		}
	}
	for _, rawQuery := range []string{"status=normal", "status=pending", "status=completed"} {
		if code := searchStatus(t, e, rawQuery); code != http.StatusOK {
			t.Fatalf("GET ?%s status = %d, want 200", rawQuery, code)
		}
	}
}

func TestWorkMemoSearchPaginationLimits(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-21", "<p>shared</p>")

	for _, rawQuery := range []string{
		"q=shared&page=0",
		"q=shared&page=-1",
		"q=shared&page=abc",
		"q=shared&page_size=0",
		"q=shared&page_size=51",
		"q=shared&page_size=-10",
		"q=shared&page_size=abc",
		"q=shared&sort=relevance",
		"q=shared&sort=updated_desc",
	} {
		if code := searchStatus(t, e, rawQuery); code != http.StatusBadRequest {
			t.Fatalf("GET ?%s status = %d, want 400", rawQuery, code)
		}
	}

	// Boundary values are accepted.
	for _, rawQuery := range []string{"q=shared&page=1", "q=shared&page_size=1", "q=shared&page_size=50"} {
		if code := searchStatus(t, e, rawQuery); code != http.StatusOK {
			t.Fatalf("GET ?%s status = %d, want 200", rawQuery, code)
		}
	}

	payload := searchWorkMemoHTTP(t, e, "q=shared&page=1&page_size=1")
	page, pageSize, total, totalPages := searchTotals(t, payload)
	if page != 1 || pageSize != 1 || total != 1 || totalPages != 1 {
		t.Fatalf("paging = %d/%d %d %d", page, pageSize, total, totalPages)
	}
}

func TestWorkMemoSearchQueryLengthAndTermLimits(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	// 200 characters is accepted, 201 is not. Counted in runes so a Chinese
	// query is measured by characters, not bytes.
	atLimit := strings.Repeat("钢", 200)
	if code := searchStatus(t, e, "q="+atLimit); code != http.StatusOK {
		t.Fatalf("200-char q status = %d, want 200", code)
	}
	overLimit := strings.Repeat("钢", 201)
	if code := searchStatus(t, e, "q="+overLimit); code != http.StatusBadRequest {
		t.Fatalf("201-char q status = %d, want 400", code)
	}

	tenTerms := strings.Repeat("a+", 9) + "a"
	if code := searchStatus(t, e, "q="+tenTerms); code != http.StatusOK {
		t.Fatalf("10-term q status = %d, want 200", code)
	}
	elevenTerms := strings.Repeat("a+", 10) + "a"
	if code := searchStatus(t, e, "q="+elevenTerms); code != http.StatusBadRequest {
		t.Fatalf("11-term q status = %d, want 400", code)
	}
}

func TestWorkMemoSearchSnippetIsPlainText(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	long := strings.Repeat("前", 120) + "钢平台" + strings.Repeat("后", 120)
	createWorkMemoAuto(t, e, "2026-08-21", "<p>"+long+"</p>")

	payload := searchWorkMemoHTTP(t, e, "q=钢平台")
	items := searchItemMaps(t, payload)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	snippet, _ := items[0]["snippet"].(string)

	if !strings.Contains(snippet, "钢平台") {
		t.Fatalf("snippet must contain the match context: %q", snippet)
	}
	if !strings.HasPrefix(snippet, "...") || !strings.HasSuffix(snippet, "...") {
		t.Fatalf("a mid-text match should be marked on both sides: %q", snippet)
	}
	if length := utf8.RuneCountInString(snippet); length > 166 {
		t.Fatalf("snippet rune length = %d, want about 160", length)
	}
	// Plain text only: no markup and nothing that would need {@html}.
	for _, forbidden := range []string{"<", ">", "<mark>", "</mark>", "&lt;"} {
		if strings.Contains(snippet, forbidden) {
			t.Fatalf("snippet must be plain text, found %q in %q", forbidden, snippet)
		}
	}
}

func TestWorkMemoSearchSnippetWithoutQueryStartsAtBodyStart(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	body := strings.Repeat("起", 200)
	createWorkMemoAuto(t, e, "2026-08-21", "<p>"+body+"</p>")

	// A filter-only query has no match position, so the snippet is the start of
	// the visible text.
	payload := searchWorkMemoHTTP(t, e, "date_from=2026-08-21&date_to=2026-08-21")
	items := searchItemMaps(t, payload)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	snippet, _ := items[0]["snippet"].(string)
	if !strings.HasPrefix(snippet, "起") {
		t.Fatalf("snippet should start at the body start: %q", snippet)
	}
	if strings.HasPrefix(snippet, "...") {
		t.Fatalf("snippet should not carry a leading ellipsis: %q", snippet)
	}
	if !strings.HasSuffix(snippet, "...") {
		t.Fatalf("truncated snippet should end with an ellipsis: %q", snippet)
	}
}

func TestWorkMemoSearchShortSnippetIsNotTruncated(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-21", "<p>short body</p>")

	payload := searchWorkMemoHTTP(t, e, "q=short")
	items := searchItemMaps(t, payload)
	if items[0]["snippet"] != "short body" {
		t.Fatalf("snippet = %#v, want the whole body", items[0]["snippet"])
	}
}

// ---------------------------------------------------------------------------
// filters over HTTP
// ---------------------------------------------------------------------------

func TestWorkMemoSearchFilterCombinations(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemo(t, e, "2026-08-01", "<p>钢平台 alpha</p>", []string{"alpha"})
	createWorkMemo(t, e, "2026-08-10", "<p>钢平台 beta</p>", []string{"beta"})

	// q + tag
	payload := searchWorkMemoHTTP(t, e, "q=钢平台&tag=beta")
	if _, _, total, _ := searchTotals(t, payload); total != 1 {
		t.Fatalf("q + tag total = %d, want 1", total)
	}

	// tag only
	payload = searchWorkMemoHTTP(t, e, "tag=alpha")
	if _, _, total, _ := searchTotals(t, payload); total != 1 {
		t.Fatalf("tag only total = %d, want 1", total)
	}

	// status only
	payload = searchWorkMemoHTTP(t, e, "status=normal")
	if _, _, total, _ := searchTotals(t, payload); total != 2 {
		t.Fatalf("status only total = %d, want 2", total)
	}

	// date range only, inclusive on both ends
	payload = searchWorkMemoHTTP(t, e, "date_from=2026-08-10&date_to=2026-08-10")
	if _, _, total, _ := searchTotals(t, payload); total != 1 {
		t.Fatalf("date range total = %d, want 1", total)
	}

	// q + date range
	payload = searchWorkMemoHTTP(t, e, "q=钢平台&date_from=2026-08-02")
	if _, _, total, _ := searchTotals(t, payload); total != 1 {
		t.Fatalf("q + date total = %d, want 1", total)
	}
}

func TestWorkMemoSearchSortOrderOverHTTP(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-01", "<p>shared</p>")
	createWorkMemoAuto(t, e, "2026-08-20", "<p>shared</p>")
	createWorkMemoAuto(t, e, "2026-08-10", "<p>shared</p>")

	dates := func(rawQuery string) []string {
		items := searchItemMaps(t, searchWorkMemoHTTP(t, e, rawQuery))
		out := make([]string, 0, len(items))
		for _, item := range items {
			out = append(out, item["date"].(string))
		}
		return out
	}

	if got := dates("q=shared"); strings.Join(got, ",") != "2026-08-20,2026-08-10,2026-08-01" {
		t.Fatalf("default sort = %v, want date_desc", got)
	}
	if got := dates("q=shared&sort=date_desc"); strings.Join(got, ",") != "2026-08-20,2026-08-10,2026-08-01" {
		t.Fatalf("date_desc = %v", got)
	}
	if got := dates("q=shared&sort=date_asc"); strings.Join(got, ",") != "2026-08-01,2026-08-10,2026-08-20" {
		t.Fatalf("date_asc = %v", got)
	}
}

func TestWorkMemoSearchPaginationOverHTTP(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	for day := 1; day <= 25; day++ {
		createWorkMemoAuto(t, e, "2026-08-"+twoDigitDay(day), "<p>shared</p>")
	}

	seen := map[string]bool{}
	for page := 1; page <= 3; page++ {
		payload := searchWorkMemoHTTP(t, e, "q=shared&page="+itoa(page)+"&page_size=10")
		gotPage, gotSize, total, totalPages := searchTotals(t, payload)
		if gotPage != page || gotSize != 10 || total != 25 || totalPages != 3 {
			t.Fatalf("page %d paging = %d/%d %d %d", page, gotPage, gotSize, total, totalPages)
		}
		for _, item := range searchItemMaps(t, payload) {
			id := item["id"].(string)
			if seen[id] {
				t.Fatalf("id %s returned on two pages", id)
			}
			seen[id] = true
		}
	}
	if len(seen) != 25 {
		t.Fatalf("paged over %d memos, want 25", len(seen))
	}

	// A page past the end reports the real total with no items.
	payload := searchWorkMemoHTTP(t, e, "q=shared&page=99&page_size=10")
	items := searchItemMaps(t, payload)
	if len(items) != 0 {
		t.Fatalf("page 99 items = %d, want 0", len(items))
	}
	if _, _, total, totalPages := searchTotals(t, payload); total != 25 || totalPages != 3 {
		t.Fatalf("page 99 total = %d total_pages = %d", total, totalPages)
	}
}

// ---------------------------------------------------------------------------
// owner isolation over HTTP (task items 27-29)
// ---------------------------------------------------------------------------

func TestWorkMemoSearchOwnerIsolationOverHTTP(t *testing.T) {
	s := newTestStore(t)
	userA := newTestUser(t, s)
	userB := newTestUser(t, s)
	eA := registerWorkMemoTestRoutes(t, s, userA)
	eB := registerWorkMemoTestRoutes(t, s, userB)

	createWorkMemo(t, eA, "2026-08-01", "<p>shared keyword A only</p>", []string{"alpha"})
	createWorkMemo(t, eA, "2026-08-02", "<p>shared keyword A second</p>", []string{"alpha"})
	createWorkMemo(t, eB, "2026-08-01", "<p>shared keyword B only</p>", []string{"beta"})
	createWorkMemo(t, eB, "2026-08-02", "<p>shared keyword B second</p>", []string{"beta"})
	createWorkMemo(t, eB, "2026-08-03", "<p>shared keyword B third</p>", []string{"beta"})

	payload := searchWorkMemoHTTP(t, eA, "q=keyword")
	items := searchItemMaps(t, payload)
	_, _, total, _ := searchTotals(t, payload)
	if total != 2 || len(items) != 2 {
		t.Fatalf("user A total = %d items = %d, want 2/2", total, len(items))
	}
	for _, item := range items {
		if snippet := item["snippet"].(string); !strings.Contains(snippet, " A ") {
			t.Fatalf("user A received another user's memo: %q", snippet)
		}
		tags, _ := item["tags"].([]any)
		if len(tags) != 1 || tags[0] != "alpha" {
			t.Fatalf("user A received another user's metadata: %#v", tags)
		}
	}

	// A filter that only matches B's rows must return nothing for A: neither
	// items nor a count that reveals B's data.
	payload = searchWorkMemoHTTP(t, eA, "tag=beta")
	if items := searchItemMaps(t, payload); len(items) != 0 {
		t.Fatalf("user A tag=beta items = %d, want 0", len(items))
	}
	if _, _, total, totalPages := searchTotals(t, payload); total != 0 || totalPages != 0 {
		t.Fatalf("user A tag=beta total = %d total_pages = %d, want 0/0", total, totalPages)
	}

	payload = searchWorkMemoHTTP(t, eA, "q=B+only")
	if items := searchItemMaps(t, payload); len(items) != 0 {
		t.Fatalf("user A q=\"B only\" items = %d, want 0", len(items))
	}

	// Sanity check the other direction.
	payload = searchWorkMemoHTTP(t, eB, "q=keyword")
	if _, _, total, _ := searchTotals(t, payload); total != 3 {
		t.Fatalf("user B total = %d, want 3", total)
	}
}

// ---------------------------------------------------------------------------
// read-only guarantees
// ---------------------------------------------------------------------------

func TestWorkMemoSearchIsReadOnly(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	memo := createWorkMemo(t, e, "2026-08-21", `<p>钢平台</p><img src="/api/v1/media/medApi/file" data-media-id="medApi">`, []string{"alpha"})

	memosBefore, associationsBefore := countWorkMemoRows(t, s)

	for _, rawQuery := range []string{
		"q=钢平台",
		"q=medApi",
		"tag=alpha",
		"status=normal",
		"date_from=2026-08-01&date_to=2026-08-31",
		"q=missing",
		"page=5&q=钢平台",
	} {
		searchWorkMemoHTTP(t, e, rawQuery)
	}

	memosAfter, associationsAfter := countWorkMemoRows(t, s)
	if memosBefore != memosAfter || associationsBefore != associationsAfter {
		t.Fatalf("search mutated rows: memos %d->%d associations %d->%d",
			memosBefore, memosAfter, associationsBefore, associationsAfter)
	}

	// The memo is untouched, including its media id and content.
	rec := performRequest(t, e, http.MethodGet, "/api/v1/work-memos/"+memo["id"].(string), nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get memo status = %d", rec.Code)
	}
	fetched := decodeJSONBody(t, rec)
	if !strings.Contains(fetched["content"].(string), `data-media-id="medApi"`) {
		t.Fatalf("content was changed: %#v", fetched["content"])
	}
}

func TestWorkMemoSearchIgnoresClientSuppliedSearchText(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	// A client must not be able to seed the derived column.
	body, _ := json.Marshal(map[string]any{
		"date":        "2026-08-21",
		"content":     "<p>real body</p>",
		"search_text": "injectedneedle",
	})
	rec := performRequest(t, e, http.MethodPost, "/api/v1/work-memos", strings.NewReader(string(body)), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body = %s", rec.Code, rec.Body.String())
	}
	created := decodeJSONBody(t, rec)

	if _, _, total, _ := searchTotals(t, searchWorkMemoHTTP(t, e, "q=injectedneedle")); total != 0 {
		t.Fatalf("client-supplied search_text was honoured, total = %d", total)
	}

	// The same holds for update.
	updateBody, _ := json.Marshal(map[string]any{"search_text": "updateinjected"})
	rec = performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+created["id"].(string), strings.NewReader(string(updateBody)), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d body = %s", rec.Code, rec.Body.String())
	}
	if _, _, total, _ := searchTotals(t, searchWorkMemoHTTP(t, e, "q=updateinjected")); total != 0 {
		t.Fatalf("client-supplied search_text was honoured on update, total = %d", total)
	}

	// The derived value still reflects the real content.
	if _, _, total, _ := searchTotals(t, searchWorkMemoHTTP(t, e, "q=real")); total != 1 {
		t.Fatalf("derived text lost, total = %d", total)
	}
}

func TestWorkMemoSearchReflectsContentUpdate(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	created := createWorkMemoAuto(t, e, "2026-08-21", "<p>initial text</p>")

	updateBody, _ := json.Marshal(map[string]any{"content": "<p>revised text</p>"})
	rec := performRequest(t, e, http.MethodPut, "/api/v1/work-memos/"+created["id"].(string), strings.NewReader(string(updateBody)), map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d body = %s", rec.Code, rec.Body.String())
	}

	if _, _, total, _ := searchTotals(t, searchWorkMemoHTTP(t, e, "q=initial")); total != 0 {
		t.Fatalf("stale content still searchable, total = %d", total)
	}
	if _, _, total, _ := searchTotals(t, searchWorkMemoHTTP(t, e, "q=revised")); total != 1 {
		t.Fatalf("revised content total = %d, want 1", total)
	}
}

func TestWorkMemoSearchNeverMatchesImageIdentifiers(t *testing.T) {
	s := newTestStore(t)
	user := newTestUser(t, s)
	e := registerWorkMemoTestRoutes(t, s, user)

	createWorkMemoAuto(t, e, "2026-08-21", `<p>进度</p><img src="blob:http://localhost/abcdef" data-uploading="true">`)
	createWorkMemoAuto(t, e, "2026-08-22", `<p>照片</p><img src="/api/v1/media/medAaa/file" data-media-id="medAaa">`)

	for _, term := range []string{"blob", "abcdef", "medAaa", "data-media-id", "api", "localhost"} {
		if _, _, total, _ := searchTotals(t, searchWorkMemoHTTP(t, e, "q="+term)); total != 0 {
			t.Fatalf("term %q matched image metadata, total = %d", term, total)
		}
	}

	// The literal percent sign must not turn into a match-everything wildcard.
	if _, _, total, _ := searchTotals(t, searchWorkMemoHTTP(t, e, "q=%25")); total != 0 {
		t.Fatalf("literal %% matched %d memos, want 0", total)
	}
	if _, _, total, _ := searchTotals(t, searchWorkMemoHTTP(t, e, "q=%25%25")); total != 0 {
		t.Fatalf("literal %%%% matched %d memos, want 0", total)
	}

	// A two-character "_" wildcard attempt must stay literal.
	if _, _, total, _ := searchTotals(t, searchWorkMemoHTTP(t, e, "q=_%25")); total != 0 {
		t.Fatalf("literal _%% matched %d memos, want 0", total)
	}
}

func twoDigitDay(day int) string {
	return string([]byte{'0' + byte(day/10), '0' + byte(day%10)})
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 4)
	for value > 0 {
		digits = append([]byte{'0' + byte(value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
