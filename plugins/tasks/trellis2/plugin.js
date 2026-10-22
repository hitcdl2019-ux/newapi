const MODEL = "trellis-2.4b";

export const meta = {
  apiVersion: 1,
  key: "trellis2",
  name: "TRELLIS.2",
  icon: "text:T3D",
  version: "1.0.0",
  author: { name: "New API" },
  description: {
    en: "OpenAI Responses API bridge for a self-hosted TRELLIS.2 image-to-3D service",
    zh: "将自部署 TRELLIS.2 图生 3D 服务适配为 OpenAI Responses 接口",
  },
  baseUrl: "http://60.171.65.125:30056",
  models: [MODEL],
  fetchMode: "per_task",
  protocols: [{ name: "openai_responses", models: [MODEL], supports: ["stream", "sync", "background"] }],
  usageSchema: {
    asset_count: {
      type: "number",
      unit: "count",
      unitLabel: { en: "asset", zh: "个" },
      description: { en: "3D asset generation unit price", zh: "3D 资产生成单价" },
    },
    latent_res: {
      enum: ["512", "1024", "1536"],
      enumLabels: {
        "512": { en: "512", zh: "512" },
        "1024": { en: "1024", zh: "1024" },
        "1536": { en: "1536", zh: "1536" },
      },
      description: { en: "Latent resolution", zh: "潜空间分辨率" },
    },
  },
  usageExamples: [{ label: "512", facts: { asset_count: 1, latent_res: "512" } }],
};

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(name + " must be an object");
  return value;
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
  const imageBase64 = normalizeBase64(option(req, metadata, "image_base64", "") || req.image || input.images[0]);
  if (!imageBase64) throw new Error("input image is required as data URL or image_base64");
  const latentRes = integerValue(option(req, metadata, "latent_res", 512), "latent_res", 512);
  if (![512, 1024, 1536].includes(latentRes)) throw new Error("latent_res must be 512, 1024, or 1536");
  const seed = integerValue(option(req, metadata, "seed", 42), "seed", 42);
  if (seed < 0 || seed > 2147483647) throw new Error("seed must be between 0 and 2147483647");
  const decimationTarget = integerValue(option(req, metadata, "decimation_target", 1000000), "decimation_target", 1000000);
  if (decimationTarget <= 0) throw new Error("decimation_target must be a positive integer");
  return {
    model: trimmed(req.model) || trimmed(ctx.model) || MODEL,
    image_base64: imageBase64,
    image_name: trimmed(option(req, metadata, "image_name", "input.png")) || "input.png",
    glb_name: trimmed(option(req, metadata, "glb_name", "asset")) || "asset",
    latent_res: String(latentRes),
    seed: seed,
    decimation_target: decimationTarget,
    prompt: input.prompt || trimmed(req.prompt),
  };
}

function apiRoot(ctx) {
  return trimmed(ctx.baseUrl).replace(/\/+$/, "");
}

function joinURL(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return apiRoot({ baseUrl: baseUrl }) + "/" + String(path || "").replace(/^\/+/, "");
}

function glbPath(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  if (trimmed(data.glb_url)) return trimmed(data.glb_url);
  const artifacts = data.artifacts;
  if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
    const glb = artifacts.glb;
    if (glb && typeof glb === "object" && !Array.isArray(glb) && trimmed(glb.url)) return trimmed(glb.url);
  }
  return "";
}

function responsesText(ctx) {
  const artifact = ctx && ctx.artifacts && ctx.artifacts.glb;
  const url = trimmed(artifact && artifact.url);
  if (!url) throw new Error("GLB artifact is unavailable");
  return "TRELLIS.2 3D asset is ready: " + url;
}

export function buildSubmitRequest(ctx) {
  const req = objectValue(ctx.requestBody, "requestBody");
  return {
    url: apiRoot(ctx) + "/generate",
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: {
      image_base64: req.image_base64,
      image_name: req.image_name || "input.png",
      glb_name: req.glb_name || "asset",
      latent_res: Number(req.latent_res || 512),
      seed: req.seed === undefined ? 42 : req.seed,
      decimation_target: req.decimation_target || 1000000,
    },
    action: "image_to_3d",
    model: req.model || MODEL,
  };
}

export function parseSubmitResponse(_ctx, resp) {
  const body = objectValue(resp.body, "TRELLIS submit response");
  const taskId = trimmed(body.job_id || body.id);
  if (!taskId) throw new Error("TRELLIS submit response missing job_id");
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return { url: apiRoot(ctx) + "/jobs/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Accept: "application/json" } };
}

export function parseTaskResult(_ctx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "UNKNOWN", reason: "invalid TRELLIS job response" };
  const status = String(body.status || "").toLowerCase();
  if (status === "queued" || status === "pending") return { status: "QUEUED", progress: "10%" };
  if (status === "running" || status === "processing") return { status: "IN_PROGRESS", progress: "50%" };
  if (status === "succeeded" || status === "success" || status === "completed") return { status: "SUCCESS", progress: "100%", url: glbPath(body) };
  if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
    const reason = body.error ? String(body.error) : body.message ? String(body.message) : "TRELLIS generation failed";
    return { status: "FAILURE", progress: "100%", reason: reason };
  }
  return { status: "UNKNOWN", reason: "unrecognized TRELLIS job status: " + String(body.status || "") };
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  return { asset_count: 1, latent_res: String(req.latent_res || 512) };
}

export function extractUsageOnComplete(ctx) {
  const data = ctx.data || {};
  return { asset_count: 1, latent_res: String(data.latent_res || 512) };
}

export function listArtifacts(task) {
  if (!task || task.status !== "SUCCESS") return [];
  if (!glbPath(task.data)) return [];
  return [{ key: "glb", type: "file", mimeType: "model/gltf-binary" }];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "glb") throw new Error("artifact_not_found");
  const path = glbPath(ctx.data);
  if (!path) throw new Error("artifact_not_found");
  return { url: joinURL(ctx.baseUrl, path), method: ctx.clientRequest && ctx.clientRequest.method ? ctx.clientRequest.method : "GET", headers: { Accept: "model/gltf-binary,application/octet-stream,*/*" } };
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      const requestBody = normalizeRequest(ctx);
      return { kind: "submit", model: requestBody.model, action: "image_to_3d", requestBody: requestBody };
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
        metadata: { vendor: "trellis2" },
      };
    },
  },
};
