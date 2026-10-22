const MODEL = "qwen-image-2.1";
const UPSTREAM_MODEL = "qwen";
export const meta = {
  apiVersion: 1,
  key: "qwen_image21",
  name: "Qwen Image 2.1",
  icon: "Qwen.Color",
  version: "1.0.0",
  author: { name: "New API" },
  description: {
    en: "OpenAI Images API bridge for a self-hosted Qwen-Image-2.1 task service.",
    zh: "将自部署 Qwen-Image-2.1 任务式接口适配为 OpenAI 图片接口。",
  },
  baseUrl: "http://42.193.117.211:18083",
  models: [MODEL],
  fetchMode: "per_task",
  protocols: [{ name: "openai_image", models: [MODEL] }],
  usageSchema: {
    image_count: {
      type: "number",
      unit: "count",
      unitLabel: { en: "image", zh: "张" },
      description: { en: "Image generation unit price", zh: "图片生成单价" },
    },
  },
  usageExamples: [{ label: "1 image", facts: { image_count: 1 } }],
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

function parseBoolean(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(name + " must be true or false");
}

function parseInteger(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(name + " must be an integer");
  return number;
}

function parseSize(size) {
  const text = trimmed(size).toLowerCase();
  if (!text) return {};
  const match = text.match(/^(\d+)\s*[x*]\s*(\d+)$/);
  if (!match) throw new Error("size must look like 512x512");
  return { width: Number(match[1]), height: Number(match[2]) };
}

function normalizeCommon(req) {
  const normalized = {};
  const fromSize = parseSize(req.size);
  normalized.width = parseInteger(req.width !== undefined ? req.width : fromSize.width, "width");
  normalized.height = parseInteger(req.height !== undefined ? req.height : fromSize.height, "height");
  normalized.seed = parseInteger(req.seed, "seed");
  normalized.steps = parseInteger(req.steps, "steps");
  normalized.transparent = parseBoolean(req.transparent, "transparent");
  if (req.response_format !== undefined && req.response_format !== "url") {
    // The upstream result endpoint is authenticated. Returning b64_json would
    // require a host-side authenticated artifact download, so keep the first
    // version explicit and reliable.
    throw new Error("response_format=b64_json is not supported by qwen_image21; use url");
  }
  return normalized;
}

function imageFileRefs(files) {
  const refs = [];
  for (const file of files || []) {
    if (file.field === "image" || file.field === "image[]" || /^image\[\d*\]$/.test(file.field) || file.field === "images") {
      refs.push(file.ref);
      continue;
    }
    if (file.field === "mask") throw new Error("mask is not supported by this Qwen bridge");
    throw new Error(file.field + " is not supported");
  }
  return refs;
}

function decodeBody(ctx) {
  if (ctx.body && ctx.body.kind === "json") {
    return objectValue(ctx.body.value, "request body");
  }
  if (ctx.body && ctx.body.kind === "multipart") {
    const fields = ctx.body.fields || {};
    const req = {};
    for (const name of Object.keys(fields)) {
      req[name] = firstField(fields, name);
    }
    req.imageFileRefs = imageFileRefs(ctx.body.files || []);
    return req;
  }
  throw new Error("JSON or multipart body required");
}

function normalizeRequest(ctx) {
  const req = decodeBody(ctx);
  const prompt = trimmed(req.prompt);
  if (!prompt) throw new Error("prompt is required");
  const n = parseInteger(req.n === undefined ? 1 : req.n, "n");
  if (n !== 1) throw new Error("n must be 1; the self-hosted Qwen service returns one image per task");
  const common = normalizeCommon(req);
  const imageRefs = Array.isArray(req.imageFileRefs) ? req.imageFileRefs : [];
  if (ctx.operation === "edit" && imageRefs.length === 0) {
    throw new Error("multipart image upload is required for image edits");
  }
  if (ctx.operation === "generate" && imageRefs.length !== 0) {
    throw new Error("image uploads are only supported on /v1/images/edits");
  }
  return Object.assign(
    {
      model: MODEL,
      upstream_model: UPSTREAM_MODEL,
      operation: imageRefs.length ? "image_edit" : "text_to_image",
      prompt: prompt,
      imageFileRefs: imageRefs,
      n: 1,
    },
    common
  );
}

function apiRoot(ctx) {
  return trimmed(ctx.baseUrl).replace(/\/+$/, "");
}

function bearerAuthorization(ctx) {
  const header = trimmed(ctx.authHeader);
  if (/^Bearer\s+/i.test(header)) return header;
  const key = trimmed(ctx.apiKey || header);
  return key ? "Bearer " + key : "";
}

function addPart(parts, name, value) {
  if (value !== undefined && value !== null && value !== "") parts.push({ name: name, value: value });
}

function resultPath(data, upstreamTaskId) {
  if (data && typeof data === "object" && !Array.isArray(data) && trimmed(data.result_url)) return trimmed(data.result_url);
  if (trimmed(upstreamTaskId)) return "/v1/tasks/" + encodeURIComponent(trimmed(upstreamTaskId)) + "/result";
  return "";
}

function joinURL(baseUrl, path) {
  const base = apiRoot({ baseUrl: baseUrl });
  if (/^https?:\/\//i.test(path)) return path;
  return base + "/" + String(path || "").replace(/^\/+/, "");
}

export const protocols = {
  openai_image: {
    decodeRequest: function (ctx) {
      if (trimmed(ctx.model) !== MODEL) throw new Error("unsupported model");
      return { kind: "submit", model: MODEL, action: ctx.operation === "edit" ? "image_edit" : "text_to_image", requestBody: normalizeRequest(ctx) };
    },
    render: function (ctx, task) {
      return {
        created: task.created_at,
        data: [{ url: "/v1/tasks/" + encodeURIComponent(task.task_id) + "/artifacts/image/content" }],
      };
    },
  },
};

export function buildSubmitRequest(ctx) {
  const req = objectValue(ctx.requestBody, "requestBody");
  const parts = [];
  addPart(parts, "model", UPSTREAM_MODEL);
  addPart(parts, "operation", req.operation || "text_to_image");
  addPart(parts, "prompt", req.prompt);
  addPart(parts, "width", req.width);
  addPart(parts, "height", req.height);
  addPart(parts, "seed", req.seed);
  addPart(parts, "steps", req.steps);
  addPart(parts, "transparent", req.transparent);
  const refs = Array.isArray(req.imageFileRefs) ? req.imageFileRefs : [];
  if (refs.length === 1) parts.push({ name: "image", fileRef: refs[0] });
  else if (refs.length > 1) {
    for (const ref of refs) parts.push({ name: "images", fileRef: ref });
  }
  return {
    url: apiRoot(ctx) + "/v1/tasks",
    method: "POST",
    headers: { Accept: "application/json", Authorization: bearerAuthorization(ctx) },
    bodyType: "multipart",
    parts: parts,
    action: req.operation || "text_to_image",
    model: MODEL,
    rewriteModel: UPSTREAM_MODEL,
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid Qwen submit response");
  const taskId = trimmed(body.id || body.task_id || body.taskId);
  if (!taskId) throw new Error("Qwen submit response missing task id");
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return {
    url: apiRoot(ctx) + "/v1/tasks/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Accept: "application/json", Authorization: bearerAuthorization(ctx) },
  };
}

export function parseTaskResult(ctx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "UNKNOWN", reason: "invalid Qwen task response" };
  const status = String(body.status || "").toLowerCase();
  if (status === "queued" || status === "pending" || status === "submitted") return { status: "QUEUED", progress: "10%" };
  if (status === "running" || status === "processing" || status === "in_progress") return { status: "IN_PROGRESS", progress: "50%" };
  if (status === "succeeded" || status === "success" || status === "completed" || status === "done") {
    return { status: "SUCCESS", progress: "100%", url: resultPath(body, ctx.taskId) };
  }
  if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
    let reason = status || "image generation failed";
    if (body.error) reason = typeof body.error === "string" ? body.error : body.error.message || JSON.stringify(body.error);
    return { status: "FAILURE", progress: "100%", reason: reason };
  }
  return { status: "UNKNOWN", reason: "unrecognized Qwen task status: " + String(body.status || "") };
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  return { image_count: Number(req.n || 1) || 1 };
}

export function extractUsageOnComplete() {
  return { image_count: 1 };
}

export function listArtifacts(task) {
  if (!task || task.status !== "SUCCESS") return [];
  return [{ key: "image", type: "image", mimeType: "image/png" }];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "image") throw new Error("artifact_not_found");
  const path = resultPath(ctx.data, ctx.upstreamTaskId);
  if (!path) throw new Error("artifact_not_found");
  return {
    url: joinURL(ctx.baseUrl, path),
    method: ctx.clientRequest && ctx.clientRequest.method ? ctx.clientRequest.method : "GET",
    headers: { Authorization: bearerAuthorization(ctx), Accept: "image/png,image/*,*/*" },
  };
}
