package plugins_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	builtinplugins "github.com/QuantumNous/new-api/plugins"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newWhiteModelVideoPlugin(t *testing.T) (*jsplugin.Registry, *jsplugin.LoadedPlugin) {
	t.Helper()
	source, err := builtinplugins.Source("white_model_video")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "white_model_video"})
	require.NoError(t, err)
	return registry, plugin
}

func callWhiteModelObject(t *testing.T, plugin *jsplugin.LoadedPlugin, name string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.Call(context.Background(), name, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func callWhiteModelPathObject(t *testing.T, plugin *jsplugin.LoadedPlugin, path []string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.CallPath(context.Background(), "protocols", path, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func TestWhiteModelVideoProtocols(t *testing.T) {
	registry, plugin := newWhiteModelVideoPlugin(t)
	responsesBinding, found := registry.Generation().LookupEndpoint(http.MethodPost, "/v1/responses", "white-model-video")
	require.True(t, found)
	assert.Same(t, plugin, responsesBinding.Plugin)
	assert.Equal(t, "openai_responses", responsesBinding.Protocol)
	videoBinding, found := registry.Generation().LookupEndpoint(http.MethodPost, "/v1/videos", "white-model-video")
	require.True(t, found)
	assert.Same(t, plugin, videoBinding.Plugin)
	assert.Equal(t, "openai_video", videoBinding.Protocol)

	intent := callWhiteModelPathObject(t, plugin, []string{"openai_video", "decodeRequest"}, map[string]any{
		"protocol": "openai_video",
		"model":    "white-model-video",
		"body": map[string]any{"kind": "multipart", "fields": map[string]any{
			"prompt": []any{"a person walks through a cafe"},
			"seed":   []any{"7"},
		}, "files": []any{map[string]any{"ref": "request_file:scene", "field": "scene", "filename": "scene.png", "mimeType": "image/png", "size": float64(12)}}},
	})
	assert.Equal(t, "submit", intent["kind"])
	assert.Equal(t, "image_to_video", intent["action"])
	req := intent["requestBody"].(map[string]any)
	assert.Equal(t, "a person walks through a cafe", req["prompt"])
	assert.Equal(t, float64(7), req["seed"])
	assert.Equal(t, "request_file:scene", req["sceneFileRef"])

	descriptor := callWhiteModelObject(t, plugin, "buildSubmitRequest", map[string]any{
		"requestBody": req,
		"baseUrl":     "http://white.example:30440",
		"apiKey":      "test-key",
		"authHeader":  "test-key",
	})
	assert.Equal(t, "http://white.example:30440/v1/jobs", descriptor["url"])
	assert.Equal(t, "multipart", descriptor["bodyType"])
	assert.Equal(t, "Bearer test-key", descriptor["headers"].(map[string]any)["Authorization"])
	parts := descriptor["parts"].([]any)
	var scenePart map[string]any
	partValues := map[string]any{}
	for _, raw := range parts {
		part := raw.(map[string]any)
		if value, ok := part["value"]; ok {
			partValues[part["name"].(string)] = value
		}
		if part["name"] == "scene" {
			scenePart = part
		}
	}
	assert.Equal(t, "a person walks through a cafe", partValues["prompt"])
	assert.Equal(t, "true", partValues["confirm_cost"])
	require.NotNil(t, scenePart)
	assert.Equal(t, "request_file:scene", scenePart["fileRef"])

	query := callWhiteModelObject(t, plugin, "buildQueryRequest", map[string]any{"baseUrl": "http://white.example:30440", "taskId": "job-1", "apiKey": "test-key"})
	assert.Equal(t, "http://white.example:30440/v1/jobs/job-1", query["url"])

	result := callWhiteModelObject(t, plugin, "parseTaskResult", map[string]any{}, map[string]any{
		"id": "job-1", "status": "succeeded", "artifacts": map[string]any{"final.mp4": "/v1/jobs/job-1/artifacts/final.mp4"},
	}, map[string]any{"status": float64(200)})
	assert.Equal(t, "SUCCESS", result["status"])
	assert.Equal(t, "/v1/jobs/job-1/artifacts/final.mp4", result["url"])

	content := callWhiteModelObject(t, plugin, "buildContentRequest", map[string]any{
		"artifactKey":    "video",
		"baseUrl":        "http://white.example:30440",
		"upstreamTaskId": "job-1",
		"apiKey":         "test-key",
		"data":           map[string]any{"artifacts": map[string]any{"final.mp4": "/v1/jobs/job-1/artifacts/final.mp4"}},
		"clientRequest":  map[string]any{"method": "HEAD"},
	})
	assert.Equal(t, "http://white.example:30440/v1/jobs/job-1/artifacts/final.mp4", content["url"])
	assert.Equal(t, "GET", content["method"])
}

func TestWhiteModelVideoResponsesProtocol(t *testing.T) {
	_, plugin := newWhiteModelVideoPlugin(t)
	intent := callWhiteModelPathObject(t, plugin, []string{"openai_responses", "decodeRequest"}, map[string]any{
		"protocol": "openai_responses",
		"model":    "white-model-video",
		"body": map[string]any{"kind": "json", "value": map[string]any{
			"model":    "white-model-video",
			"input":    "a person walks through a cafe",
			"metadata": map[string]any{"seed": float64(9)},
		}},
	})
	assert.Equal(t, "text_to_video", intent["action"])
	req := intent["requestBody"].(map[string]any)
	assert.Equal(t, "a person walks through a cafe", req["prompt"])
	assert.Equal(t, float64(9), req["seed"])

	facts := callWhiteModelObject(t, plugin, "extractUsage", map[string]any{"requestBody": req})
	assert.Equal(t, map[string]any{"seconds": float64(10)}, facts)

	_, err := plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_responses", "decodeRequest"}, map[string]any{
		"model": "white-model-video",
		"body": map[string]any{"kind": "json", "value": map[string]any{"model": "white-model-video", "input": []any{map[string]any{
			"type": "input_image", "image_url": "data:image/png;base64,aGVsbG8=",
		}}}},
	})
	require.ErrorContains(t, err, "multipart /v1/videos")
}
