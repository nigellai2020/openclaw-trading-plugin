type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function sanitizeBacktestResultResponse(
  body: unknown,
  fallbackJobId?: string,
): JsonObject {
  const response = asObject(body);
  if (!response) {
    return fallbackJobId ? { jobId: fallbackJobId } : {};
  }

  const result = asObject(response.result);
  const sanitizedResult: JsonObject = {};

  const portfolio = asObject(result?.portfolio);
  if (portfolio) sanitizedResult.portfolio = portfolio;

  const metrics = asObject(result?.metrics);
  if (metrics) sanitizedResult.metrics = metrics;

  const trades = asObject(result?.trades);
  if (trades) sanitizedResult.trades = trades;

  const sanitized: JsonObject = {};
  const jobId = asString(response.jobId) ?? asString(response.job_id) ?? fallbackJobId;
  if (jobId) sanitized.jobId = jobId;

  const status = asString(response.status);
  if (status) sanitized.status = status;

  if (Object.keys(sanitizedResult).length > 0) {
    sanitized.result = sanitizedResult;
  }

  return sanitized;
}
