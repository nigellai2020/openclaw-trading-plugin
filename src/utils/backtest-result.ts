type JsonObject = Record<string, unknown>;

export type BacktestResultMode = "detail" | "link";

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildLink(webUrl?: string, npub?: string, agentId?: number): string | undefined {
  if (!webUrl || !npub || agentId == null) return undefined;
  return `${webUrl}/trading-agents/${npub}/${agentId}`;
}

export function sanitizeBacktestResultResponse(
  body: unknown,
  fallbackJobId?: string,
  options?: { mode?: BacktestResultMode; npub?: string; agentId?: number; webUrl?: string },
): JsonObject {
  const mode: BacktestResultMode = options?.mode ?? "detail";
  const link = buildLink(options?.webUrl, options?.npub, options?.agentId);

  const response = asObject(body) ?? {};
  const jobId = asString(response.jobId) ?? asString(response.job_id) ?? fallbackJobId;
  const status = asString(response.status);

  if (mode === "link" && link) {
    const sanitized: JsonObject = {};
    if (jobId) sanitized.jobId = jobId;
    if (status) sanitized.status = status;
    sanitized.link = link;
    return sanitized;
  }

  const sanitized: JsonObject = {};
  if (jobId) sanitized.jobId = jobId;
  if (status) sanitized.status = status;

  const result = asObject(response.result);
  const sanitizedResult: JsonObject = {};

  const portfolio = asObject(result?.portfolio);
  if (portfolio) sanitizedResult.portfolio = portfolio;

  const metrics = asObject(result?.metrics);
  if (metrics) sanitizedResult.metrics = metrics;

  const trades = asObject(result?.trades);
  if (trades) sanitizedResult.trades = trades;

  if (Object.keys(sanitizedResult).length > 0) {
    sanitized.result = sanitizedResult;
  }

  if (link) sanitized.link = link;

  if (mode === "link" && !link) {
    sanitized.note = "agentId not provided — returning detail instead.";
  }

  return sanitized;
}
