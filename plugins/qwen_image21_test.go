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

func newQwenImage21Plugin(t *testing.T) (*jsplugin.Registry, *jsplugin.LoadedPlugin) {
	t.Helper()
	source, err := builtinplugins.Source("qwen_image21")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "qwen_image21"})
	require.NoError(t, err)
	return registry, plugin
}

func callQwenObject(t *testing.T, plugin *jsplugin.LoadedPlugin, name string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.Call(context.Background(), name, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func callQwenPathObject(t *testing.T, plugin *jsplugin.LoadedPlugin, path []string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.CallPath(context.Background(), "protocols", path, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func TestQwenImage21PluginOpenAIImageProtocol(t *testing.T) {
	registry, plugin := newQwenImage21Plugin(t)
	for _, endpoint := range []string{"/v1/images/generations", "/v1/images/edits"} {
		binding, found := registry.Generation().LookupEndpoint(http.MethodPost, endpoint, "qwen-image-2.1")
		require.True(t, found, endpoint)
		assert.Same(t, plugin, binding.Plugin)
		assert.Equal(t, "openai_image", binding.Protocol)
	}

	intent := callQwenPathObject(t, plugin, []string{"openai_image", "decodeRequest"}, map[string]any{
		"protocol":  "openai_image",
		"operation": "generate",
		"model":     "qwen-image-2.1",
		"path":      "/v1/images/generations",
		"method":    http.MethodPost,
		"body": map[string]any{"kind": "json", "value": map[string]any{
			"model":  "qwen-image-2.1",
			"prompt": "a red apple",
			"size":   "512x768",
			"steps":  float64(8),
			"seed":   float64(123),
		}},
	})
	assert.Equal(t, "submit", intent["kind"])
	assert.Equal(t, "qwen-image-2.1", intent["model"])
	assert.Equal(t, "text_to_image", intent["action"])
	req := intent["requestBody"].(map[string]any)
	assert.Equal(t, "text_to_image", req["operation"])
	assert.Equal(t, float64(512), req["width"])
	assert.Equal(t, float64(768), req["height"])
	assert.Equal(t, float64(8), req["steps"])

	descriptor := callQwenObject(t, plugin, "buildSubmitRequest", map[string]any{
		"requestBody": req,
		"baseUrl":     "http://qwen.example:18083",
		"apiKey":      "test-key",
		"authHeader":  "Bearer test-key",
	})
	assert.Equal(t, "http://qwen.example:18083/v1/tasks", descriptor["url"])
	assert.Equal(t, "multipart", descriptor["bodyType"])
	assert.Equal(t, "qwen", descriptor["rewriteModel"])
	parts := descriptor["parts"].([]any)
	partValues := map[string]any{}
	for _, raw := range parts {
		part := raw.(map[string]any)
		if value, ok := part["value"]; ok {
			partValues[part["name"].(string)] = value
		}
	}
	assert.Equal(t, "qwen", partValues["model"])
	assert.Equal(t, "text_to_image", partValues["operation"])
	assert.Equal(t, "a red apple", partValues["prompt"])
	assert.Equal(t, float64(512), partValues["width"])

	submit := callQwenObject(t, plugin, "parseSubmitResponse", map[string]any{}, map[string]any{
		"statusCode": float64(202),
		"body":       map[string]any{"id": "upstream-task", "status": "queued"},
	})
	assert.Equal(t, "upstream-task", submit["taskId"])

	query := callQwenObject(t, plugin, "buildQueryRequest", map[string]any{
		"baseUrl":    "http://qwen.example:18083",
		"taskId":     "upstream-task",
		"apiKey":     "test-key",
		"authHeader": "test-key",
	})
	assert.Equal(t, "http://qwen.example:18083/v1/tasks/upstream-task", query["url"])
	assert.Equal(t, "Bearer test-key", query["headers"].(map[string]any)["Authorization"])

	result := callQwenObject(t, plugin, "parseTaskResult", map[string]any{"taskId": "upstream-task"}, map[string]any{
		"id":         "upstream-task",
		"status":     "succeeded",
		"result_url": "/v1/tasks/upstream-task/result",
	}, map[string]any{"status": float64(200)})
	assert.Equal(t, "SUCCESS", result["status"])
	assert.Equal(t, "/v1/tasks/upstream-task/result", result["url"])

	rendered := callQwenPathObject(t, plugin, []string{"openai_image", "render"}, map[string]any{}, map[string]any{
		"task_id":    "public-task",
		"status":     "SUCCESS",
		"created_at": float64(1710000000),
		"data":       map[string]any{"result_url": "/v1/tasks/upstream-task/result"},
	})
	data := rendered["data"].([]any)
	require.Len(t, data, 1)
	assert.Equal(t, "/v1/tasks/public-task/artifacts/image/content", data[0].(map[string]any)["url"])
}

func TestQwenImage21EditArtifactAndValidation(t *testing.T) {
	_, plugin := newQwenImage21Plugin(t)
	intent := callQwenPathObject(t, plugin, []string{"openai_image", "decodeRequest"}, map[string]any{
		"protocol":  "openai_image",
		"operation": "edit",
		"model":     "qwen-image-2.1",
		"path":      "/v1/images/edits",
		"method":    http.MethodPost,
		"body": map[string]any{"kind": "multipart", "fields": map[string]any{
			"prompt": []any{"make it watercolor"},
			"size":   []any{"512x512"},
		}, "files": []any{map[string]any{"ref": "request_file:image", "field": "image", "filename": "input.png", "mimeType": "image/png", "size": float64(12)}}},
	})
	assert.Equal(t, "image_edit", intent["action"])
	req := intent["requestBody"].(map[string]any)
	assert.Equal(t, "image_edit", req["operation"])
	assert.Equal(t, []any{"request_file:image"}, req["imageFileRefs"])

	descriptor := callQwenObject(t, plugin, "buildSubmitRequest", map[string]any{
		"requestBody": req,
		"baseUrl":     "http://qwen.example:18083",
		"apiKey":      "test-key",
	})
	parts := descriptor["parts"].([]any)
	var imagePart map[string]any
	for _, raw := range parts {
		part := raw.(map[string]any)
		if part["name"] == "image" {
			imagePart = part
		}
	}
	require.NotNil(t, imagePart)
	assert.Equal(t, "request_file:image", imagePart["fileRef"])

	artifactsValue, err := plugin.Engine.Call(context.Background(), "listArtifacts", map[string]any{"status": "SUCCESS"})
	require.NoError(t, err)
	encoded, err := common.Marshal(artifactsValue)
	require.NoError(t, err)
	var artifacts []map[string]any
	require.NoError(t, common.Unmarshal(encoded, &artifacts))
	require.Len(t, artifacts, 1)
	assert.Equal(t, "image", artifacts[0]["key"])

	content := callQwenObject(t, plugin, "buildContentRequest", map[string]any{
		"artifactKey":    "image",
		"baseUrl":        "http://qwen.example:18083",
		"apiKey":         "test-key",
		"authHeader":     "test-key",
		"upstreamTaskId": "upstream-task",
		"data":           map[string]any{"result_url": "/v1/tasks/upstream-task/result"},
		"clientRequest":  map[string]any{"method": "GET"},
	})
	assert.Equal(t, "http://qwen.example:18083/v1/tasks/upstream-task/result", content["url"])
	assert.Equal(t, "Bearer test-key", content["headers"].(map[string]any)["Authorization"])

	_, err = plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_image", "decodeRequest"}, map[string]any{
		"protocol":  "openai_image",
		"operation": "generate",
		"model":     "qwen-image-2.1",
		"body": map[string]any{"kind": "json", "value": map[string]any{
			"model":           "qwen-image-2.1",
			"prompt":          "a cat",
			"response_format": "b64_json",
		}},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "b64_json")
}
