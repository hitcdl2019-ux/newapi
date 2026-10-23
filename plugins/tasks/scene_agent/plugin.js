const MODEL = "scene-agent-v1";

export const meta = {
  apiVersion: 1,
  key: "scene_agent",
  name: "Scene Agent",
  icon: "text:场景",
  version: "1.0.0",
  author: { name: "New API" },
  description: {
    en: "OpenAI Responses bridge for a self-hosted scene generation agent service",
    zh: "将自部署场景生成 Agent 服务适配为 OpenAI Responses 接口",
  },
  baseUrl: "http://60.171.65.125:30175",
  models: [MODEL],
  fetchMode: "per_task",
  protocols: [{ name: "openai_responses", models: [MODEL], supports: ["stream", "sync", "background"] }],
  usageSchema: {
    scene_count: {
      type: "number",
      unit: "count",
      unitLabel: { en: "scene", zh: "个" },
      description: { en: "Scene generation unit price", zh: "场景生成单价" },
    },
  },
  usageExamples: [{ label: "1 scene", facts: { scene_count: 1 } }],
};

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(name + " must be an object");
  return value;
}

function apiRoot(ctx) {
  return trimmed(ctx.baseUrl).replace(/\/+$/, "");
}

function apiKeyHeader(ctx) {
  const header = trimmed(ctx.authHeader);
  if (/^Bearer\s+/i.test(header)) return trimmed(header.replace(/^Bearer\s+/i, ""));
  return trimmed(ctx.apiKey || header);
}

function integerValue(value, name, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(name + " must be an integer");
  return number;
}

function option(req, metadata, name, defaultValue) {
  if (Object.prototype.hasOwnProperty.call(req, name)) return req[name];
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, name)) return metadata[name];
  return defaultValue;
}

function normalizeBase64(image) {
  const value = trimmed(image);
  if (!value) return "";
  const dataPrefix = value.match(/^data:[^;]+;base64,/i);
  if (dataPrefix) return value.slice(dataPrefix[0].length).trim();
  if (/^https?:\/\//i.test(value)) throw new Error("input image URL is not supported; use a data URL or image_base64");
  return value;
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
        if (["input_image", "image_url"].includes(part.type)) {
          let image = part.image_url || part.image_base64;
          if (image && typeof image === "object") image = image.url;
          if (trimmed(image)) images.push(trimmed(image));
        }
      }
    }
  }
  return {
    prompt: texts.filter(function (text) { return trimmed(text); }).join("\n"),
    images: images,
  };
}

function normalizeRequest(ctx) {
  if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
  const req = objectValue(ctx.body.value, "request body");
  const metadata = req.metadata && typeof req.metadata === "object" && !Array.isArray(req.metadata) ? req.metadata : {};
  const input = responsesInput(req);
  const prompt = input.prompt || trimmed(req.prompt);
  const image = normalizeBase64(option(req, metadata, "image_base64", "") || req.image || input.images[0]);
  if (!prompt && !image) throw new Error("input text or image is required");
  if (input.images.length > 1) throw new Error("only one scene reference image is supported");
  const maxHeroCategories = integerValue(option(req, metadata, "max_hero_categories", undefined), "max_hero_categories", undefined);
  if (maxHeroCategories !== undefined && (maxHeroCategories < 1 || maxHeroCategories > 64)) throw new Error("max_hero_categories must be between 1 and 64");
  const maxHeroInstances = integerValue(option(req, metadata, "max_hero_instances", undefined), "max_hero_instances", undefined);
  if (maxHeroInstances !== undefined && (maxHeroInstances < 1 || maxHeroInstances > 100)) throw new Error("max_hero_instances must be between 1 and 100");
  const referenceReasoningEffort = trimmed(option(req, metadata, "reference_reasoning_effort", ""));
  if (referenceReasoningEffort && !["low", "high", "max"].includes(referenceReasoningEffort)) throw new Error("reference_reasoning_effort must be low, high, or max");
  const roomGeometryMode = trimmed(option(req, metadata, "room_geometry_mode", ""));
  return {
    model: trimmed(req.model) || ctx.model || MODEL,
    prompt: prompt,
    image_base64: image,
    task_id: trimmed(option(req, metadata, "task_id", "")),
    room_geometry_mode: roomGeometryMode,
    reference_reasoning_effort: referenceReasoningEffort,
    max_hero_categories: maxHeroCategories,
    max_hero_instances: maxHeroInstances,
  };
}

function addPart(parts, name, value) {
  if (value !== undefined && value !== null && value !== "") parts.push({ name: name, value: value });
}

function artifactPath(data, taskId, filename) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const artifacts = data.artifacts;
    if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
      const value = artifacts[filename] || artifacts[filename.replace("scene.", "")];
      if (trimmed(value)) return trimmed(value);
      if (value && typeof value === "object" && !Array.isArray(value) && trimmed(value.url)) return trimmed(value.url);
    }
  }
  return taskId ? "/v1/unified/jobs/" + encodeURIComponent(taskId) + "/artifacts/" + filename : "";
}

function joinURL(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return apiRoot({ baseUrl: baseUrl }) + "/" + String(path || "").replace(/^\/+/, "");
}

function responsesText(ctx) {
  const glb = ctx && ctx.artifacts && ctx.artifacts.glb;
  const blend = ctx && ctx.artifacts && ctx.artifacts.blend;
  const glbURL = trimmed(glb && glb.url);
  if (!glbURL) throw new Error("scene GLB artifact is unavailable");
  const blendURL = trimmed(blend && blend.url);
  return blendURL ? "Scene is ready. GLB: " + glbURL + "\nBlend: " + blendURL : "Scene is ready. GLB: " + glbURL;
}

export function buildSubmitRequest(ctx) {
  const req = objectValue(ctx.requestBody, "requestBody");
  const parts = [];
  addPart(parts, "prompt", req.prompt);
  if (req.image_base64) addPart(parts, "image_base64", req.image_base64);
  addPart(parts, "task_id", req.task_id);
  addPart(parts, "room_geometry_mode", req.room_geometry_mode);
  addPart(parts, "reference_reasoning_effort", req.reference_reasoning_effort);
  addPart(parts, "max_hero_categories", req.max_hero_categories);
  addPart(parts, "max_hero_instances", req.max_hero_instances);
  return {
    url: apiRoot(ctx) + "/v1/unified/jobs",
    method: "POST",
    headers: { Accept: "application/json", "X-API-Key": apiKeyHeader(ctx) },
    bodyType: "multipart",
    parts: parts,
    action: req.image_base64 && req.prompt ? "prompt_image_to_scene" : req.image_base64 ? "image_to_scene" : "text_to_scene",
    model: req.model || MODEL,
  };
}

export function parseSubmitResponse(_ctx, resp) {
  const body = objectValue(resp.body, "scene submit response");
  const taskId = trimmed(body.job_id || body.id || body.task_id);
  if (!taskId) throw new Error("scene submit response missing job_id");
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return { url: apiRoot(ctx) + "/v1/unified/jobs/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Accept: "application/json", "X-API-Key": apiKeyHeader(ctx) } };
}

export function parseTaskResult(_ctx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "UNKNOWN", reason: "invalid scene job response" };
  const status = String(body.status || "").toLowerCase();
  if (status === "queued" || status === "pending") return { status: "QUEUED", progress: "10%" };
  if (status === "running" || status === "processing" || status === "in_progress") return { status: "IN_PROGRESS", progress: "50%" };
  if (status === "succeeded" || status === "success" || status === "completed") return { status: "SUCCESS", progress: "100%", url: artifactPath(body, body.job_id || body.id, "scene.glb") };
  if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
    const reason = body.error ? String(body.error) : body.message ? String(body.message) : "scene generation failed";
    return { status: "FAILURE", progress: "100%", reason: reason };
  }
  return { status: "UNKNOWN", reason: "unrecognized scene job status: " + String(body.status || "") };
}

export function extractUsage() {
  return { scene_count: 1 };
}

export function extractUsageOnComplete() {
  return { scene_count: 1 };
}

export function listArtifacts(task) {
  if (!task || task.status !== "SUCCESS") return [];
  const artifacts = [{ key: "glb", type: "file", mimeType: "model/gltf-binary" }];
  artifacts.push({ key: "blend", type: "file", mimeType: "application/octet-stream" });
  return artifacts;
}

export function buildContentRequest(ctx) {
  const filenames = { glb: "scene.glb", blend: "scene.blend" };
  const filename = filenames[ctx.artifactKey];
  if (!filename) throw new Error("artifact_not_found");
  const path = artifactPath(ctx.data, ctx.upstreamTaskId || ctx.taskId, filename);
  if (!path) throw new Error("artifact_not_found");
  return { url: joinURL(ctx.baseUrl, path), method: "GET", headers: { "X-API-Key": apiKeyHeader(ctx), Accept: "application/octet-stream,*/*" } };
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      const requestBody = normalizeRequest(ctx);
      return { kind: "submit", model: requestBody.model, action: requestBody.image_base64 && requestBody.prompt ? "prompt_image_to_scene" : requestBody.image_base64 ? "image_to_scene" : "text_to_scene", requestBody: requestBody };
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const value = Number(String(task.progress || "").replace("%", ""));
      const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      const state = { status: status, progress: progress };
      if (status === "SUCCESS") {
        const text = responsesText(ctx);
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
            content: [{ type: "output_text", text: responsesText(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "scene_agent" },
      };
    },
  },
};
