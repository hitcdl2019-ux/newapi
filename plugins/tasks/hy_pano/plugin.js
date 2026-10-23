const MODEL = "hy-pano-2.0";
const DEFAULT_BASE_URL = "http://42.193.117.211:18020";
const DEFAULT_WIDTH = 1952;
const DEFAULT_HEIGHT = 960;
const DEFAULT_STEPS = 50;

export const meta = {
  apiVersion: 1,
  key: "hy_pano",
  name: "HY-Pano 2.0",
  icon: "text:全景",
  version: "1.0.0",
  author: { name: "New API" },
  description: {
    en: "OpenAI Images API bridge for a self-hosted HY-Pano 2.0 panorama service",
    zh: "将自部署 HY-Pano 2.0 全景生成服务适配为 OpenAI 图片接口",
  },
  baseUrl: DEFAULT_BASE_URL,
  models: [MODEL],
  fetchMode: "per_task",
  protocols: [{ name: "openai_image", models: [MODEL] }],
  usageSchema: {
    image_count: {
      type: "number",
      unit: "count",
      unitLabel: { en: "panorama", zh: "张" },
      description: { en: "Panorama generation unit price", zh: "全景图生成单价" },
    },
  },
  usageExamples: [{ label: "1 panorama", facts: { image_count: 1 } }],
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

function parseInteger(value, name, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(name + " must be an integer");
  return number;
}

function parseBoolean(value, name, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(name + " must be true or false");
}

function parseSize(size) {
  const text = trimmed(size).toLowerCase();
  if (!text) return {};
  const match = text.match(/^(\d+)\s*[x*]\s*(\d+)$/);
  if (!match) throw new Error("size must look like 1952x960");
  return { width: Number(match[1]), height: Number(match[2]) };
}

function apiRoot(ctx) {
  const baseUrl = trimmed(ctx.baseUrl) || DEFAULT_BASE_URL;
  return baseUrl.replace(/\/+$/, "");
}

function imageFileRefs(files) {
  const refs = [];
  for (const file of files || []) {
    if (["image", "image[]", "input", "input_reference"].includes(file.field) || /^image\[\d*\]$/.test(file.field)) {
      refs.push({ ref: file.ref, filename: file.filename });
      continue;
    }
    if (file.field === "mask") throw new Error("mask is not supported by this HY-Pano bridge");
    throw new Error(file.field + " is not supported");
  }
  if (refs.length > 1) throw new Error("only one image is supported");
  return refs;
}

function decodeBody(ctx) {
  if (ctx.body && ctx.body.kind === "json") return objectValue(ctx.body.value, "request body");
  if (ctx.body && ctx.body.kind === "multipart") {
    const fields = ctx.body.fields || {};
    const req = {};
    for (const name of Object.keys(fields)) req[name] = firstField(fields, name);
    req.imageFiles = imageFileRefs(ctx.body.files || []);
    return req;
  }
  throw new Error("JSON or multipart body required");
}

function normalizeOptions(req, hasImage) {
  const fromSize = parseSize(req.size);
  const width = parseInteger(req.width !== undefined ? req.width : fromSize.width, "width", DEFAULT_WIDTH);
  const height = parseInteger(req.height !== undefined ? req.height : fromSize.height, "height", DEFAULT_HEIGHT);
  if (width < 64 || width > 4096) throw new Error("width must be between 64 and 4096");
  if (height < 64 || height > 4096) throw new Error("height must be between 64 and 4096");
  const steps = parseInteger(req.diff_infer_steps !== undefined ? req.diff_infer_steps : req.steps, "diff_infer_steps", DEFAULT_STEPS);
  if (steps < 1 || steps > 100) throw new Error("diff_infer_steps must be between 1 and 100");
  const seed = parseInteger(req.seed, "seed", undefined);
  if (seed !== undefined && (seed < 0 || seed > 2147483647)) throw new Error("seed must be between 0 and 2147483647");
  const reproduce = parseBoolean(req.reproduce, "reproduce", false);
  const useTaylorCache = parseBoolean(req.use_taylor_cache, "use_taylor_cache", false);
  const prompt = trimmed(req.prompt) || (hasImage ? "Expand this image to a 360-degree equirectangular panorama." : "");
  if (!prompt) throw new Error("prompt is required");
  const options = {
    prompt: prompt,
    diff_infer_steps: steps,
    height: height,
    width: width,
    reproduce: reproduce,
  };
  if (seed !== undefined) options.seed = seed;
  if (useTaylorCache) options.use_taylor_cache = true;
  const botTask = trimmed(req.bot_task);
  if (botTask) {
    if (!["image", "auto", "recaption", "think_recaption"].includes(botTask)) throw new Error("bot_task must be image, auto, recaption, or think_recaption");
    options.bot_task = botTask;
  } else if (hasImage) {
    options.bot_task = "think_recaption";
  } else {
    options.bot_task = "auto";
  }
  return options;
}

function normalizeRequest(ctx) {
  const req = decodeBody(ctx);
  const n = parseInteger(req.n === undefined ? 1 : req.n, "n", 1);
  if (n !== 1) throw new Error("n must be 1; HY-Pano returns one panorama per task");
  if (req.response_format !== undefined && req.response_format !== "url") throw new Error("response_format=b64_json is not supported by hy_pano; use url");
  const files = Array.isArray(req.imageFiles) ? req.imageFiles : [];
  if (ctx.operation === "edit" && files.length === 0) throw new Error("multipart image upload is required for image edits");
  if (ctx.operation === "generate" && files.length !== 0) throw new Error("image uploads are only supported on /v1/images/edits");
  const options = normalizeOptions(req, files.length > 0);
  return {
    model: MODEL,
    operation: files.length ? "image_to_panorama" : "text_to_panorama",
    prompt: options.prompt,
    options: options,
    imageFileRef: files.length ? files[0].ref : "",
    imageFilename: files.length ? files[0].filename : "input.png",
    n: 1,
  };
}

function resultPath(_data, upstreamTaskId) {
  if (trimmed(upstreamTaskId)) return "/v1/pano/jobs/" + encodeURIComponent(trimmed(upstreamTaskId)) + "/image";
  return "";
}

function joinURL(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return apiRoot({ baseUrl: baseUrl }) + "/" + String(path || "").replace(/^\/+/, "");
}

function statusOf(body) {
  return String(body.status || body.state || body.job_status || "").toLowerCase();
}

export const protocols = {
  openai_image: {
    decodeRequest: function (ctx) {
      if (trimmed(ctx.model) !== MODEL) throw new Error("unsupported model");
      const requestBody = normalizeRequest(ctx);
      return { kind: "submit", model: MODEL, action: requestBody.operation, requestBody: requestBody };
    },
    render: function (_ctx, task) {
      const data = task && task.data && typeof task.data === "object" ? task.data : {};
      const upstreamURL = trimmed(data.url);
      const url = upstreamURL ? joinURL(DEFAULT_BASE_URL, upstreamURL) : "/v1/tasks/" + encodeURIComponent(task.task_id) + "/artifacts/image/content";
      return { created: task.created_at, data: [{ url: url }] };
    },
  },
};

export function buildSubmitRequest(ctx) {
  const req = objectValue(ctx.requestBody, "requestBody");
  if (req.imageFileRef) {
    return {
      url: apiRoot(ctx) + "/v1/pano/jobs/upload",
      method: "POST",
      headers: { Accept: "application/json" },
      bodyType: "multipart",
      parts: [
        { name: "image", fileRef: req.imageFileRef, filename: req.imageFilename || "input.png" },
        { name: "params", value: JSON.stringify(req.options || {}) },
      ],
      action: "image_to_panorama",
      model: MODEL,
    };
  }
  return {
    url: apiRoot(ctx) + "/v1/pano/jobs/text",
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: req.options || {},
    action: "text_to_panorama",
    model: MODEL,
  };
}

export function parseSubmitResponse(_ctx, resp) {
  const body = objectValue(resp.body, "HY-Pano submit response");
  const taskId = trimmed(body.job_id || body.id || body.task_id || body.jobId);
  if (!taskId) throw new Error("HY-Pano submit response missing job id");
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return { url: apiRoot(ctx) + "/v1/pano/jobs/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Accept: "application/json" } };
}

export function parseTaskResult(ctx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "UNKNOWN", reason: "invalid HY-Pano job response" };
  const raw = statusOf(body);
  if (["queued", "pending", "submitted", "not_start", "not_started"].includes(raw)) return { status: "QUEUED", progress: "10%" };
  if (["running", "processing", "in_progress", "started"].includes(raw)) return { status: "IN_PROGRESS", progress: "50%" };
  if (["succeeded", "success", "completed", "done", "finished"].includes(raw)) return { status: "SUCCESS", progress: "100%", url: joinURL(apiRoot(ctx), resultPath(body, ctx.taskId)) };
  if (["failed", "error", "cancelled", "canceled"].includes(raw)) {
    let reason = raw || "panorama generation failed";
    if (body.error) reason = typeof body.error === "string" ? body.error : body.error.message || JSON.stringify(body.error);
    else if (body.message) reason = String(body.message);
    return { status: "FAILURE", progress: "100%", reason: reason };
  }
  if (body.image_path || body.output_path || body.result_path || body.image_url) return { status: "SUCCESS", progress: "100%", url: joinURL(apiRoot(ctx), resultPath(body, ctx.taskId)) };
  return { status: "UNKNOWN", reason: "unrecognized HY-Pano job status: " + String(body.status || body.state || body.job_status || "") };
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
  const path = resultPath(ctx.data, ctx.upstreamTaskId || ctx.taskId);
  if (!path) throw new Error("artifact_not_found");
  return { url: joinURL(ctx.baseUrl, path), method: "GET", headers: { Accept: "image/png,image/*,*/*" } };
}
