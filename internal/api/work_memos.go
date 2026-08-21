package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/labstack/echo/v5"

	"github.com/songtianlun/diarum/internal/auth"
	"github.com/songtianlun/diarum/internal/store"
)

// RegisterWorkMemoRoutes registers REST endpoints for the independent work memo module.
func RegisterWorkMemoRoutes(e *echo.Echo, s *store.Store, authMiddleware echo.MiddlewareFunc) {
	group := e.Group("/api/v1/work-memos", authMiddleware)

	group.POST("", createWorkMemoHandler(s))
	group.GET("/by-date/:date", listWorkMemosByDateHandler(s))
	group.POST("/reorder", reorderWorkMemosHandler(s))
	group.GET("/:id", getWorkMemoHandler(s))
	group.PUT("/:id", updateWorkMemoHandler(s))
	group.DELETE("/:id", deleteWorkMemoHandler(s))
}

// optionalString unmarshals a JSON value and records whether the field was
// present in the request body and whether it was explicitly null.
// This type is not a pointer, so it can distinguish three states:
// omitted (Present=false), null (IsNull=true), and a valid string.
type optionalString struct {
	Present bool
	IsNull  bool
	Value   string
}

func (o *optionalString) UnmarshalJSON(data []byte) error {
	o.Present = true
	if string(data) == "null" {
		o.IsNull = true
		return nil
	}
	return json.Unmarshal(data, &o.Value)
}

// optionalStringSlice unmarshals a JSON value and records whether the field was
// present in the request body and whether it was explicitly null.
type optionalStringSlice struct {
	Present bool
	IsNull  bool
	Value   []string
}

func (o *optionalStringSlice) UnmarshalJSON(data []byte) error {
	o.Present = true
	if string(data) == "null" {
		o.IsNull = true
		return nil
	}
	return json.Unmarshal(data, &o.Value)
}

type createWorkMemoBody struct {
	Date     string              `json:"date"`
	Content  string              `json:"content"`
	Status   optionalString      `json:"status"`
	IsPinned bool                `json:"is_pinned"`
	Tags     optionalStringSlice `json:"tags"`
}

func createWorkMemoHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := auth.CurrentUser(c)
		var body createWorkMemoBody
		if err := c.Bind(&body); err != nil {
			return badRequest("Invalid request body", err)
		}

		if body.Date == "" {
			return badRequest("date is required", nil)
		}
		if _, err := parseWorkMemoDate(body.Date); err != nil {
			return badRequest("invalid date", err)
		}

		status := ""
		if body.Status.Present {
			if body.Status.IsNull {
				return badRequest("status cannot be null", nil)
			}
			status = body.Status.Value
			if !store.IsValidWorkMemoStatus(status) {
				return badRequest("invalid status", nil)
			}
		}

		tags := []string{}
		if body.Tags.Present {
			if body.Tags.IsNull {
				return badRequest("tags cannot be null", nil)
			}
			tags = body.Tags.Value
		}

		memo, err := s.CreateWorkMemo(user.ID, store.CreateWorkMemoInput{
			Date:     body.Date,
			Content:  body.Content,
			Status:   status,
			IsPinned: body.IsPinned,
			Tags:     tags,
		})
		if err != nil {
			return serverError("Failed to create work memo", err)
		}
		return c.JSON(http.StatusOK, formatWorkMemoResponse(memo))
	}
}

func getWorkMemoHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := auth.CurrentUser(c)
		memo, err := s.GetWorkMemo(c.PathParam("id"), user.ID)
		if err != nil {
			if store.IsNoRows(err) {
				return notFound("Work memo not found")
			}
			return serverError("Failed to fetch work memo", err)
		}
		return c.JSON(http.StatusOK, formatWorkMemoResponse(memo))
	}
}

func listWorkMemosByDateHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := auth.CurrentUser(c)
		date := c.PathParam("date")
		if _, err := parseWorkMemoDate(date); err != nil {
			return badRequest("invalid date", err)
		}
		memos, err := s.ListWorkMemosByDate(user.ID, date)
		if err != nil {
			return serverError("Failed to list work memos", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"date": date, "memos": formatWorkMemos(memos)})
	}
}

type updateWorkMemoBody struct {
	Content  *string             `json:"content,omitempty"`
	Date     *string             `json:"date,omitempty"`
	Status   optionalString      `json:"status,omitempty"`
	IsPinned *bool               `json:"is_pinned,omitempty"`
	Tags     optionalStringSlice `json:"tags,omitempty"`
}

func updateWorkMemoHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := auth.CurrentUser(c)
		var body updateWorkMemoBody
		if err := c.Bind(&body); err != nil {
			return badRequest("Invalid request body", err)
		}

		input := store.UpdateWorkMemoInput{
			Content:  body.Content,
			Date:     body.Date,
			IsPinned: body.IsPinned,
		}

		if body.Date != nil {
			if _, err := parseWorkMemoDate(*body.Date); err != nil {
				return badRequest("invalid date", err)
			}
		}
		if body.Status.Present {
			if body.Status.IsNull {
				return badRequest("status cannot be null", nil)
			}
			if !store.IsValidWorkMemoStatus(body.Status.Value) {
				return badRequest("invalid status", nil)
			}
			input.Status = &body.Status.Value
		}
		if body.Tags.Present {
			if body.Tags.IsNull {
				return badRequest("tags cannot be null", nil)
			}
			input.Tags = &body.Tags.Value
		}

		memo, err := s.UpdateWorkMemo(user.ID, c.PathParam("id"), input)
		if err != nil {
			if store.IsNoRows(err) {
				return notFound("Work memo not found")
			}
			return serverError("Failed to update work memo", err)
		}
		return c.JSON(http.StatusOK, formatWorkMemoResponse(memo))
	}
}

func deleteWorkMemoHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := auth.CurrentUser(c)
		if err := s.DeleteWorkMemo(c.PathParam("id"), user.ID); err != nil {
			if store.IsNoRows(err) {
				return notFound("Work memo not found")
			}
			return serverError("Failed to delete work memo", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"success": true})
	}
}

type reorderWorkMemosBody struct {
	Date string   `json:"date"`
	IDs  []string `json:"ids"`
}

func reorderWorkMemosHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := auth.CurrentUser(c)
		var body reorderWorkMemosBody
		if err := c.Bind(&body); err != nil {
			return badRequest("Invalid request body", err)
		}
		if body.Date == "" {
			return badRequest("date is required", nil)
		}
		if _, err := parseWorkMemoDate(body.Date); err != nil {
			return badRequest("invalid date", err)
		}
		if len(body.IDs) == 0 {
			return badRequest("ids are required", nil)
		}

		if err := s.ReorderWorkMemos(user.ID, body.Date, body.IDs); err != nil {
			if errors.Is(err, store.ErrInvalidReorder) {
				return badRequest("invalid reorder request", nil)
			}
			return serverError("Failed to reorder work memos", err)
		}

		memos, err := s.ListWorkMemosByDate(user.ID, body.Date)
		if err != nil {
			return serverError("Failed to list work memos after reorder", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"date": body.Date, "memos": formatWorkMemos(memos)})
	}
}

func parseWorkMemoDate(value string) (string, error) {
	if value == "" {
		return "", errors.New("date is required")
	}
	if _, err := time.Parse("2006-01-02", value); err != nil {
		return "", err
	}
	return value, nil
}

func formatWorkMemoResponse(memo *store.WorkMemo) map[string]any {
	return map[string]any{
		"id":        memo.ID,
		"owner":     memo.Owner,
		"date":      store.FormatWorkMemoDateAPI(memo.Date),
		"content":   memo.Content,
		"status":    memo.Status,
		"is_pinned": memo.IsPinned,
		"position":  memo.Position,
		"tags":      memo.Tags,
		"created":   memo.Created,
		"updated":   memo.Updated,
	}
}

func formatWorkMemos(memos []*store.WorkMemo) []map[string]any {
	out := make([]map[string]any, 0, len(memos))
	for _, memo := range memos {
		out = append(out, formatWorkMemoResponse(memo))
	}
	return out
}
