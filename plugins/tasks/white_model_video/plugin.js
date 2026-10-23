const MODEL = "white-model-video";
const FIXED_SECONDS = 10;

export const meta = {
  apiVersion: 1,
  key: "white_model_video",
  name: "White Model Video",
  icon: "text:白模",
  version: "1.0.0",
  author: { name: "New API" },
  description: {
    en: "OpenAI Video and Responses bridge for a self-hosted white model video service",
    zh: "将自部署白模视频服务适配为 OpenAI Video 和 Responses 接口",
  },
  baseUrl: "http://60.171.65.125:30440",
  models: [MODEL],
  fetchMode: "per_task",
  protocols: [{ name: "openai_responses", models: [MODEL], supports: ["stream", "sync", "background"] }, { name: "openai_video", models: [MODEL] }],
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
  },
  usageExamples: [{ label: "10s", facts: { seconds: FIXED_SECONDS } }],
};

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(name + " must be an object");
  return value;
}

function firstField(fields, name) {
  const values = fields[name] || [];
  if (values.length > 1) throw new Error(name + " must be provided once");
  return values[0];
}

function integerValue(value, name, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(name + " must be an integer");
  return number;
}

function bearerAuthorization(ctx) {
  const header = trimmed(ctx.authHeader);
  if (/^Bearer\s+/i.test(header)) return header;
  const key = trimmed(ctx.apiKey || header);
  return key ? "Bearer " + key : "";
}

function apiRoot(ctx) {
  return trimmed(ctx.baseUrl).replace(/\/+$/, "");
}

function responsesInput(req) {
  const texts = [];
  const images = [];
  const input = req.input;
  if (typeof input === "string") texts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = item.content === undefined ? [item] : Array.isArray(item.content) ? item.content : [item.content];
      for (const part of content) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        if (["input_text", "text"].includes(part.type) && typeof part.text === "string") texts.push(part.text);
        if (["input_image", "image_url"].includes(part.type)) images.push(part);
      }
    }
  }
  return {
    prompt: texts.filter(function (text) { return trimmed(text); }).join("\n"),
    imageCount: images.length,
  };
}

function normalizeSeed(value) {
  const seed = integerValue(value, "seed", 42);
  if (seed < 0 || seed > 2147483647) throw new Error("seed must be between 0 and 2147483647");
  return seed;
}

function normalizeVideoJSON(ctx) {
  const req = objectValue(ctx.body.value, "request body");
  const prompt = trimmed(req.prompt || req.input);
  if (!prompt) throw new Error("prompt is required");
  if (req.scene || req.input_reference || req.image) throw new Error("scene image upload requires multipart /v1/videos");
  return { model: trimmed(req.model) || ctx.model || MODEL, prompt: prompt, seed: normalizeSeed(req.seed) };
}

function normalizeVideoMultipart(ctx) {
  const fields = ctx.body.fields || {};
  const req = {};
  for (const name of Object.keys(fields)) req[name] = firstField(fields, name);
  const prompt = trimmed(req.prompt || req.input);
  if (!prompt) throw new Error("prompt is required");
  let sceneFile = null;
  for (const file of ctx.body.files || []) {
    if (!["scene", "input_reference", "image"].includes(file.field)) throw new Error("unexpected file field: " + file.field);
    if (sceneFile) throw new Error("scene image must be provided once");
    sceneFile = file;
  }
  return {
    model: trimmed(req.model) || ctx.model || MODEL,
    prompt: prompt,
    seed: normalizeSeed(req.seed),
    sceneFileRef: sceneFile ? sceneFile.ref : "",
    sceneFilename: sceneFile ? sceneFile.filename : "",
  };
}

function normalizeResponses(ctx) {
  if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
  const req = objectValue(ctx.body.value, "request body");
  if (req.input !== undefined && typeof req.input !== "string" && !Array.isArray(req.input)) throw new Error("input must be a string or array");
  const input = responsesInput(req);
  if (input.imageCount) throw new Error("scene image upload requires multipart /v1/videos");
  const metadata = req.metadata && typeof req.metadata === "object" && !Array.isArray(req.metadata) ? req.metadata : {};
  const prompt = input.prompt || trimmed(req.prompt);
  if (!prompt) throw new Error("input is required");
  return {
    model: trimmed(req.model) || ctx.model || MODEL,
    prompt: prompt,
    seed: normalizeSeed(req.seed !== undefined ? req.seed : metadata.seed),
  };
}

function addPart(parts, name, value) {
  if (value !== undefined && value !== null && value !== "") parts.push({ name: name, value: value });
}

function artifactPath(data, taskId) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const artifacts = data.artifacts;
    if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
      const final = artifacts["final.mp4"];
      if (trimmed(final)) return trimmed(final);
      if (final && typeof final === "object" && !Array.isArray(final) && trimmed(final.url)) return trimmed(final.url);
    }
  }
  return taskId ? "/v1/jobs/" + encodeURIComponent(taskId) + "/artifacts/final.mp4" : "";
}

function joinURL(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return apiRoot({ baseUrl: baseUrl }) + "/" + String(path || "").replace(/^\/+/, "");
}

function responsesVideoText(ctx) {
  const artifact = ctx && ctx.artifacts && ctx.artifacts.video;
  const url = trimmed(artifact && artifact.url);
  if (!url) throw new Error("video artifact is unavailable");
  const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return '<video controls src="' + escaped + '"></video>';
}

export function buildSubmitRequest(ctx) {
  const req = objectValue(ctx.requestBody, "requestBody");
  const parts = [];
  addPart(parts, "prompt", req.prompt);
  addPart(parts, "seed", req.seed === undefined ? 42 : req.seed);
  addPart(parts, "confirm_cost", "true");
  if (req.sceneFileRef) parts.push({ name: "scene", fileRef: req.sceneFileRef, filename: req.sceneFilename || "scene.png" });
  return {
    url: apiRoot(ctx) + "/v1/jobs",
    method: "POST",
    headers: { Accept: "application/json", Authorization: bearerAuthorization(ctx) },
    bodyType: "multipart",
    parts: parts,
    action: req.sceneFileRef ? "image_to_video" : "text_to_video",
    model: req.model || MODEL,
  };
}

export function parseSubmitResponse(_ctx, resp) {
  const body = objectValue(resp.body, "white video submit response");
  const taskId = trimmed(body.id || body.job_id || body.task_id);
  if (!taskId) throw new Error("white video submit response missing id");
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return { url: apiRoot(ctx) + "/v1/jobs/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Accept: "application/json", Authorization: bearerAuthorization(ctx) } };
}

export function parseTaskResult(_ctx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "UNKNOWN", reason: "invalid white video job response" };
  const status = String(body.status || "").toLowerCase();
  if (status === "queued" || status === "pending") return { status: "QUEUED", progress: "10%" };
  if (status === "running" || status === "processing" || status === "in_progress") return { status: "IN_PROGRESS", progress: "50%" };
  if (status === "succeeded" || status === "success" || status === "completed") return { status: "SUCCESS", progress: "100%", url: artifactPath(body, body.id) };
  if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
    const reason = body.error ? String(body.error) : body.message ? String(body.message) : "white video generation failed";
    return { status: "FAILURE", progress: "100%", reason: reason };
  }
  return { status: "UNKNOWN", reason: "unrecognized white video job status: " + String(body.status || "") };
}

export function extractUsage() {
  return { seconds: FIXED_SECONDS };
}

export function extractUsageOnComplete() {
  return { seconds: FIXED_SECONDS };
}

export function listArtifacts(task) {
  if (!task || task.status !== "SUCCESS") return [];
  return [{ key: "video", type: "video", mimeType: "video/mp4" }];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const path = artifactPath(ctx.data, ctx.upstreamTaskId || ctx.taskId);
  if (!path) throw new Error("artifact_not_found");
  return { url: joinURL(ctx.baseUrl, path), method: "GET", headers: { Authorization: bearerAuthorization(ctx), Accept: "video/mp4,application/octet-stream,*/*" } };
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      const requestBody = normalizeResponses(ctx);
      return { kind: "submit", model: requestBody.model, action: "text_to_video", requestBody: requestBody };
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const value = Number(String(task.progress || "").replace("%", ""));
      const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      const state = { status: status, progress: progress };
      if (status === "SUCCESS") {
        const text = responsesVideoText(ctx);
        const events = previousState && previousState.status === status ? [] : [{ type: "output", data: text }];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE") return { events: [{ type: "error", code: "task_failed", message: task.fail_reason || "task failed" }], state: state, done: true };
      if (previousState && previousState.status === status && previousState.progress === progress) return { events: [], state: state, done: false };
      const event = { type: "progress", message: status.toLowerCase() };
      if (progress !== null) event.progress = progress;
      return { events: [event], state: state, done: false };
    },
    renderFinal: function (ctx, _task) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: responsesVideoText(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "white_model_video" },
      };
    },
  },
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) throw new Error("JSON or multipart body required");
      const requestBody = ctx.body.kind === "json" ? normalizeVideoJSON(ctx) : normalizeVideoMultipart(ctx);
      return { kind: "submit", model: requestBody.model, action: requestBody.sceneFileRef ? "image_to_video" : "text_to_video", requestBody: requestBody };
    },
    render: function (_ctx, task) {
      const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
      const output = {
        id: task.task_id,
        object: "video",
        model: (task.properties || {}).origin_model_name || MODEL,
        status: statuses[task.status] || "unknown",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: Number(task.created_at || 0),
      };
      const completedAt = Number(task.finished_at || task.updated_at || 0);
      if (completedAt > 0) output.completed_at = completedAt;
      if (task.status === "FAILURE") output.error = { code: "video_generation_failed", message: task.fail_reason || "The video generation task failed." };
      if (task.status === "SUCCESS") output.content_url = "/v1/videos/" + encodeURIComponent(task.task_id) + "/content";
      return output;
    },
  },
};
