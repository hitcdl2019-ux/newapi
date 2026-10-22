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

func newTrellis2Plugin(t *testing.T) (*jsplugin.Registry, *jsplugin.LoadedPlugin) {
	t.Helper()
	source, err := builtinplugins.Source("trellis2")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "trellis2"})
	require.NoError(t, err)
	return registry, plugin
}

func callTrellisObject(t *testing.T, plugin *jsplugin.LoadedPlugin, name string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.Call(context.Background(), name, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func callTrellisPathObject(t *testing.T, plugin *jsplugin.LoadedPlugin, path []string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.CallPath(context.Background(), "protocols", path, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func TestTrellis2ResponsesProtocol(t *testing.T) {
	registry, plugin := newTrellis2Plugin(t)
	binding, found := registry.Generation().LookupEndpoint(http.MethodPost, "/v1/responses", "trellis-2.4b")
	require.True(t, found)
	assert.Same(t, plugin, binding.Plugin)
	assert.Equal(t, "openai_responses", binding.Protocol)

	intent := callTrellisPathObject(t, plugin, []string{"openai_responses", "decodeRequest"}, map[string]any{
		"protocol":      "openai_responses",
		"model":         "trellis-2.4b",
		"upstreamModel": "trellis-2.4b",
		"path":          "/v1/responses",
		"method":        http.MethodPost,
		"body": map[string]any{"kind": "json", "value": map[string]any{
			"model": "trellis-2.4b",
			"input": []any{map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "input_text", "text": "make a 3D asset"},
				map[string]any{"type": "input_image", "image_url": "data:image/png;base64,aGVsbG8="},
			}}},
			"metadata": map[string]any{"latent_res": float64(512), "seed": float64(7), "decimation_target": float64(100000)},
		}},
	})
	assert.Equal(t, "submit", intent["kind"])
	assert.Equal(t, "trellis-2.4b", intent["model"])
	assert.Equal(t, "image_to_3d", intent["action"])
	req := intent["requestBody"].(map[string]any)
	assert.Equal(t, "aGVsbG8=", req["image_base64"])
	assert.Equal(t, "512", req["latent_res"])
	assert.Equal(t, float64(7), req["seed"])

	descriptor := callTrellisObject(t, plugin, "buildSubmitRequest", map[string]any{
		"requestBody": req,
		"baseUrl":     "http://trellis.example:30056",
	})
	assert.Equal(t, "http://trellis.example:30056/generate", descriptor["url"])
	assert.Equal(t, "POST", descriptor["method"])
	body := descriptor["body"].(map[string]any)
	assert.Equal(t, "aGVsbG8=", body["image_base64"])
	assert.Equal(t, float64(512), body["latent_res"])

	submit := callTrellisObject(t, plugin, "parseSubmitResponse", map[string]any{}, map[string]any{
		"statusCode": float64(202),
		"body":       map[string]any{"job_id": "job-1", "status": "queued"},
	})
	assert.Equal(t, "job-1", submit["taskId"])

	query := callTrellisObject(t, plugin, "buildQueryRequest", map[string]any{"baseUrl": "http://trellis.example:30056", "taskId": "job-1"})
	assert.Equal(t, "http://trellis.example:30056/jobs/job-1", query["url"])

	result := callTrellisObject(t, plugin, "parseTaskResult", map[string]any{}, map[string]any{
		"job_id": "job-1", "status": "succeeded", "latent_res": float64(512),
		"artifacts": map[string]any{"glb": map[string]any{"url": "/files/job-1/asset.glb"}},
	}, map[string]any{"status": float64(200)})
	assert.Equal(t, "SUCCESS", result["status"])
	assert.Equal(t, "/files/job-1/asset.glb", result["url"])

	content := callTrellisObject(t, plugin, "buildContentRequest", map[string]any{
		"artifactKey":    "glb",
		"baseUrl":        "http://trellis.example:30056",
		"upstreamTaskId": "job-1",
		"data":           map[string]any{"artifacts": map[string]any{"glb": map[string]any{"url": "/files/job-1/asset.glb"}}},
		"clientRequest":  map[string]any{"method": "GET"},
	})
	assert.Equal(t, "http://trellis.example:30056/files/job-1/asset.glb", content["url"])

	rendered := callTrellisPathObject(t, plugin, []string{"openai_responses", "renderFinal"}, map[string]any{
		"artifacts": map[string]any{"glb": map[string]any{"url": "https://gateway.example/artifacts/glb"}},
	}, map[string]any{"status": "SUCCESS"})
	output := rendered["output"].([]any)
	require.Len(t, output, 1)
	contentItems := output[0].(map[string]any)["content"].([]any)
	assert.Contains(t, contentItems[0].(map[string]any)["text"], "https://gateway.example/artifacts/glb")
}

func TestTrellis2RejectsMissingOrRemoteImage(t *testing.T) {
	_, plugin := newTrellis2Plugin(t)
	_, err := plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_responses", "decodeRequest"}, map[string]any{
		"model": "trellis-2.4b",
		"body":  map[string]any{"kind": "json", "value": map[string]any{"model": "trellis-2.4b", "input": "make a mesh"}},
	})
	require.ErrorContains(t, err, "input image is required")

	_, err = plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_responses", "decodeRequest"}, map[string]any{
		"model": "trellis-2.4b",
		"body": map[string]any{"kind": "json", "value": map[string]any{"model": "trellis-2.4b", "input": []any{map[string]any{
			"type": "input_image", "image_url": "https://cdn.example/input.png",
		}}}},
	})
	require.ErrorContains(t, err, "data URL or image_base64")
}
