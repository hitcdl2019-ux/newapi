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

func newSceneAgentPlugin(t *testing.T) (*jsplugin.Registry, *jsplugin.LoadedPlugin) {
	t.Helper()
	source, err := builtinplugins.Source("scene_agent")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "scene_agent"})
	require.NoError(t, err)
	return registry, plugin
}

func callSceneObject(t *testing.T, plugin *jsplugin.LoadedPlugin, name string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.Call(context.Background(), name, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func callScenePathObject(t *testing.T, plugin *jsplugin.LoadedPlugin, path []string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.CallPath(context.Background(), "protocols", path, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var object map[string]any
	require.NoError(t, common.Unmarshal(encoded, &object))
	return object
}

func TestSceneAgentResponsesProtocol(t *testing.T) {
	registry, plugin := newSceneAgentPlugin(t)
	binding, found := registry.Generation().LookupEndpoint(http.MethodPost, "/v1/responses", "scene-agent-v1")
	require.True(t, found)
	assert.Same(t, plugin, binding.Plugin)
	assert.Equal(t, "openai_responses", binding.Protocol)

	intent := callScenePathObject(t, plugin, []string{"openai_responses", "decodeRequest"}, map[string]any{
		"protocol": "openai_responses",
		"model":    "scene-agent-v1",
		"body": map[string]any{"kind": "json", "value": map[string]any{
			"model": "scene-agent-v1",
			"input": []any{map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "input_text", "text": "generate a meeting room"},
				map[string]any{"type": "input_image", "image_url": "data:image/png;base64,aGVsbG8="},
			}}},
			"metadata": map[string]any{"room_geometry_mode": "rectangular", "reference_reasoning_effort": "low", "max_hero_categories": float64(20)},
		}},
	})
	assert.Equal(t, "submit", intent["kind"])
	assert.Equal(t, "scene-agent-v1", intent["model"])
	assert.Equal(t, "prompt_image_to_scene", intent["action"])
	req := intent["requestBody"].(map[string]any)
	assert.Equal(t, "generate a meeting room", req["prompt"])
	assert.Equal(t, "aGVsbG8=", req["image_base64"])
	assert.Equal(t, "rectangular", req["room_geometry_mode"])

	descriptor := callSceneObject(t, plugin, "buildSubmitRequest", map[string]any{
		"requestBody": req,
		"baseUrl":     "http://scene.example:30175",
		"apiKey":      "test-key",
		"authHeader":  "Bearer test-key",
	})
	assert.Equal(t, "http://scene.example:30175/v1/unified/jobs", descriptor["url"])
	assert.Equal(t, "multipart", descriptor["bodyType"])
	assert.Equal(t, "test-key", descriptor["headers"].(map[string]any)["X-API-Key"])
	parts := descriptor["parts"].([]any)
	partValues := map[string]any{}
	for _, raw := range parts {
		part := raw.(map[string]any)
		if value, ok := part["value"]; ok {
			partValues[part["name"].(string)] = value
		}
	}
	assert.Equal(t, "generate a meeting room", partValues["prompt"])
	assert.Equal(t, "aGVsbG8=", partValues["image_base64"])

	submit := callSceneObject(t, plugin, "parseSubmitResponse", map[string]any{}, map[string]any{
		"statusCode": float64(202),
		"body":       map[string]any{"job_id": "job-1", "status": "queued"},
	})
	assert.Equal(t, "job-1", submit["taskId"])

	result := callSceneObject(t, plugin, "parseTaskResult", map[string]any{}, map[string]any{
		"job_id": "job-1", "status": "succeeded", "artifacts": map[string]any{
			"scene.glb":   "/v1/unified/jobs/job-1/artifacts/scene.glb",
			"scene.blend": "/v1/unified/jobs/job-1/artifacts/scene.blend",
		},
	}, map[string]any{"status": float64(200)})
	assert.Equal(t, "SUCCESS", result["status"])

	content := callSceneObject(t, plugin, "buildContentRequest", map[string]any{
		"artifactKey":    "glb",
		"baseUrl":        "http://scene.example:30175",
		"apiKey":         "test-key",
		"upstreamTaskId": "job-1",
		"data":           map[string]any{"artifacts": map[string]any{"scene.glb": "/v1/unified/jobs/job-1/artifacts/scene.glb"}},
	})
	assert.Equal(t, "http://scene.example:30175/v1/unified/jobs/job-1/artifacts/scene.glb", content["url"])
	assert.Equal(t, "test-key", content["headers"].(map[string]any)["X-API-Key"])

	facts := callSceneObject(t, plugin, "extractUsage", map[string]any{"requestBody": req})
	assert.Equal(t, map[string]any{"scene_count": float64(1)}, facts)
}
