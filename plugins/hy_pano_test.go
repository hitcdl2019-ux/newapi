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

func newHyPanoPlugin(t *testing.T) (*jsplugin.Registry, *jsplugin.LoadedPlugin) {
	t.Helper()
	source, err := builtinplugins.Source("hy_pano")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "hy_pano"})
	require.NoError(t, err)
	return registry, plugin
}

func callHyPanoObject(t *testing.T, plugin *jsplugin.LoadedPlugin, name string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.Call(context.Background(), name, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func callHyPanoPathObject(t *testing.T, plugin *jsplugin.LoadedPlugin, path []string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.CallPath(context.Background(), "protocols", path, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func TestHyPanoOpenAIImageGenerate(t *testing.T) {
	registry, plugin := newHyPanoPlugin(t)
	for _, endpoint := range []string{"/v1/images/generations", "/v1/images/edits"} {
		binding, found := registry.Generation().LookupEndpoint(http.MethodPost, endpoint, "hy-pano-2.0")
		require.True(t, found, endpoint)
		assert.Same(t, plugin, binding.Plugin)
		assert.Equal(t, "openai_image", binding.Protocol)
	}

	intent := callHyPanoPathObject(t, plugin, []string{"openai_image", "decodeRequest"}, map[string]any{
		"protocol":  "openai_image",
		"operation": "generate",
		"model":     "hy-pano-2.0",
		"path":      "/v1/images/generations",
		"method":    http.MethodPost,
		"body": map[string]any{"kind": "json", "value": map[string]any{
			"model":            "hy-pano-2.0",
			"prompt":           "a sunny library panorama",
			"size":             "1920x960",
			"diff_infer_steps": float64(12),
			"seed":             float64(123),
		}},
	})
	assert.Equal(t, "submit", intent["kind"])
	assert.Equal(t, "hy-pano-2.0", intent["model"])
	assert.Equal(t, "text_to_panorama", intent["action"])
	req := intent["requestBody"].(map[string]any)
	assert.Equal(t, "text_to_panorama", req["operation"])
	options := req["options"].(map[string]any)
	assert.Equal(t, "a sunny library panorama", options["prompt"])
	assert.Equal(t, float64(1920), options["width"])
	assert.Equal(t, float64(960), options["height"])
	assert.Equal(t, float64(12), options["diff_infer_steps"])
	assert.Equal(t, "auto", options["bot_task"])

	descriptor := callHyPanoObject(t, plugin, "buildSubmitRequest", map[string]any{
		"requestBody": req,
		"baseUrl":     "http://pano.example:18020",
	})
	assert.Equal(t, "http://pano.example:18020/v1/pano/jobs/text", descriptor["url"])
	assert.Equal(t, "POST", descriptor["method"])
	assert.Equal(t, "text_to_panorama", descriptor["action"])
	assert.Equal(t, options, descriptor["body"])

	submit := callHyPanoObject(t, plugin, "parseSubmitResponse", map[string]any{}, map[string]any{
		"statusCode": float64(202),
		"body":       map[string]any{"job_id": "pano-job", "status": "queued"},
	})
	assert.Equal(t, "pano-job", submit["taskId"])

	query := callHyPanoObject(t, plugin, "buildQueryRequest", map[string]any{
		"baseUrl": "http://pano.example:18020",
		"taskId":  "pano-job",
	})
	assert.Equal(t, "http://pano.example:18020/v1/pano/jobs/pano-job", query["url"])

	result := callHyPanoObject(t, plugin, "parseTaskResult", map[string]any{"taskId": "pano-job", "baseUrl": "http://pano.example:18020"}, map[string]any{
		"job_id": "pano-job",
		"status": "succeeded",
	})
	assert.Equal(t, "SUCCESS", result["status"])
	assert.Equal(t, "http://pano.example:18020/v1/pano/jobs/pano-job/image", result["url"])

	rendered := callHyPanoPathObject(t, plugin, []string{"openai_image", "render"}, map[string]any{}, map[string]any{
		"task_id":    "public-task",
		"status":     "SUCCESS",
		"created_at": float64(1710000000),
		"data":       map[string]any{"status": "succeeded", "url": "http://pano.example:18020/v1/pano/jobs/pano-job/image"},
	})
	data := rendered["data"].([]any)
	require.Len(t, data, 1)
	assert.Equal(t, "http://pano.example:18020/v1/pano/jobs/pano-job/image", data[0].(map[string]any)["url"])
}

func TestHyPanoOpenAIImageEditAndArtifact(t *testing.T) {
	_, plugin := newHyPanoPlugin(t)
	intent := callHyPanoPathObject(t, plugin, []string{"openai_image", "decodeRequest"}, map[string]any{
		"protocol":  "openai_image",
		"operation": "edit",
		"model":     "hy-pano-2.0",
		"path":      "/v1/images/edits",
		"method":    http.MethodPost,
		"body": map[string]any{"kind": "multipart", "fields": map[string]any{
			"prompt": []any{"Expand this image to a 360-degree equirectangular panorama."},
			"steps":  []any{"8"},
		}, "files": []any{map[string]any{"ref": "request_file:image", "field": "image", "filename": "room.png", "mimeType": "image/png", "size": float64(12)}}},
	})
	assert.Equal(t, "image_to_panorama", intent["action"])
	req := intent["requestBody"].(map[string]any)
	assert.Equal(t, "image_to_panorama", req["operation"])
	assert.Equal(t, "request_file:image", req["imageFileRef"])
	options := req["options"].(map[string]any)
	assert.Equal(t, "think_recaption", options["bot_task"])
	assert.Equal(t, float64(8), options["diff_infer_steps"])

	descriptor := callHyPanoObject(t, plugin, "buildSubmitRequest", map[string]any{
		"requestBody": req,
		"baseUrl":     "http://pano.example:18020",
	})
	assert.Equal(t, "http://pano.example:18020/v1/pano/jobs/upload", descriptor["url"])
	assert.Equal(t, "multipart", descriptor["bodyType"])
	parts := descriptor["parts"].([]any)
	var imagePart map[string]any
	var paramsPart map[string]any
	for _, raw := range parts {
		part := raw.(map[string]any)
		switch part["name"] {
		case "image":
			imagePart = part
		case "params":
			paramsPart = part
		}
	}
	require.NotNil(t, imagePart)
	assert.Equal(t, "request_file:image", imagePart["fileRef"])
	require.NotNil(t, paramsPart)
	assert.Contains(t, paramsPart["value"], "think_recaption")

	artifactsValue, err := plugin.Engine.Call(context.Background(), "listArtifacts", map[string]any{"status": "SUCCESS"})
	require.NoError(t, err)
	encoded, err := common.Marshal(artifactsValue)
	require.NoError(t, err)
	var artifacts []map[string]any
	require.NoError(t, common.Unmarshal(encoded, &artifacts))
	require.Len(t, artifacts, 1)
	assert.Equal(t, "image", artifacts[0]["key"])

	content := callHyPanoObject(t, plugin, "buildContentRequest", map[string]any{
		"artifactKey":    "image",
		"baseUrl":        "http://pano.example:18020",
		"upstreamTaskId": "pano-job",
		"data":           map[string]any{"status": "succeeded"},
	})
	assert.Equal(t, "http://pano.example:18020/v1/pano/jobs/pano-job/image", content["url"])

	_, err = plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_image", "decodeRequest"}, map[string]any{
		"protocol":  "openai_image",
		"operation": "generate",
		"model":     "hy-pano-2.0",
		"body": map[string]any{"kind": "json", "value": map[string]any{
			"model":           "hy-pano-2.0",
			"prompt":          "a library",
			"response_format": "b64_json",
		}},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "b64_json")
}
