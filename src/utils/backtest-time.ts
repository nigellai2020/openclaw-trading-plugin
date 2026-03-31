import type {
  BacktestNormalizedTime,
  BacktestNormalizedTimeRange,
  ParsedLocalDateTime,
} from "../types/backtest.js";

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.(\d{1,3}))?)?$/;
const NUMERIC_TIMESTAMP_RE = /^\d{10,16}$/;
const EXPLICIT_TIMEZONE_RE = /(Z|[+-]\d{2}:\d{2})$/i;
const EXPLICIT_OFFSET_CAPTURE_RE = /(Z|[+-]\d{2}:\d{2})$/i;
const DEFAULT_BACKTEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const AMBIGUOUS_TIMEZONE_ABBREVIATIONS = new Set([
  "est",
  "edt",
  "cst",
  "cdt",
  "mst",
  "mdt",
  "pst",
  "pdt",
  "bst",
]);
const COMMON_TIMEZONE_ALIASES: Record<string, string> = {
  utc: "UTC",
  gmt: "UTC",
  "hk time": "Asia/Hong_Kong",
  hk: "Asia/Hong_Kong",
  hkt: "Asia/Hong_Kong",
  "hong kong": "Asia/Hong_Kong",
  "hong kong time": "Asia/Hong_Kong",
  "toronto time": "America/Toronto",
  toronto: "America/Toronto",
  "new york time": "America/New_York",
  "new york": "America/New_York",
};

function resolveRuntimeTimeZone(): string {
  const intlTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (intlTimeZone) return intlTimeZone;
  if (typeof process.env.TZ === "string" && process.env.TZ.trim()) {
    return process.env.TZ.trim();
  }
  return "UTC";
}

function toInt(value: string, label: string, originalInput: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${label} in backtest time: ${originalInput}`);
  }
  return parsed;
}

function canonicalizeTimeZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Unsupported timeZone: "${timeZone}"`);
  }
}

function resolveBacktestTimeZoneOverride(timeZone?: string): string | undefined {
  if (!timeZone) return undefined;
  const normalized = timeZone.trim();
  if (!normalized) return undefined;
  const key = normalized.toLowerCase().replace(/\s+/g, " ");
  if (AMBIGUOUS_TIMEZONE_ABBREVIATIONS.has(key)) {
    throw new Error(`Ambiguous timeZone "${timeZone}". Use an IANA zone like "Asia/Hong_Kong" or a clearer phrase like "Hong Kong time"`);
  }
  const alias = COMMON_TIMEZONE_ALIASES[key];
  return canonicalizeTimeZone(alias ?? normalized);
}

function parseDateOnly(value: string): ParsedLocalDateTime | null {
  const match = value.match(DATE_ONLY_RE);
  if (!match) return null;
  const [, year, month, day] = match;
  return {
    year: toInt(year, "year", value),
    month: toInt(month, "month", value),
    day: toInt(day, "day", value),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
}

function parseNaiveDateTime(value: string): ParsedLocalDateTime | null {
  const match = value.match(NAIVE_DATETIME_RE);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", , fraction = ""] = match;
  return {
    year: toInt(year, "year", value),
    month: toInt(month, "month", value),
    day: toInt(day, "day", value),
    hour: toInt(hour, "hour", value),
    minute: toInt(minute, "minute", value),
    second: toInt(second, "second", value),
    millisecond: toInt(fraction.padEnd(3, "0"), "millisecond", value),
  };
}

const backtestTimeZoneFormatters = new Map<string, Intl.DateTimeFormat>();

function getBacktestTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = backtestTimeZoneFormatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  backtestTimeZoneFormatters.set(timeZone, formatter);
  return formatter;
}

function getZonedParts(date: Date, timeZone: string): ParsedLocalDateTime {
  const formatter = getBacktestTimeZoneFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new Error(`Unable to resolve ${type} in timezone ${timeZone}`);
    }
    return Number(value);
  };
  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
    hour: getPart("hour"),
    minute: getPart("minute"),
    second: getPart("second"),
    millisecond: date.getUTCMilliseconds(),
  };
}

function sameParsedLocalDateTime(a: ParsedLocalDateTime, b: ParsedLocalDateTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second &&
    a.millisecond === b.millisecond
  );
}

function getTimeZoneOffsetMillis(instantMs: number, timeZone: string): number {
  const date = new Date(instantMs);
  const zoned = getZonedParts(date, timeZone);
  const zonedAsUtc = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second,
    zoned.millisecond,
  );
  return zonedAsUtc - instantMs;
}

function buildZonedDate(
  parts: ParsedLocalDateTime,
  originalInput: string,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );

  let instantMs = utcGuess;
  for (let i = 0; i < 3; i += 1) {
    const offset = getTimeZoneOffsetMillis(instantMs, timeZone);
    const adjusted = utcGuess - offset;
    if (adjusted === instantMs) break;
    instantMs = adjusted;
  }

  const date = new Date(instantMs);
  if (!sameParsedLocalDateTime(getZonedParts(date, timeZone), parts)) {
    throw new Error(`Invalid backtest time "${originalInput}" in timezone ${timeZone}`);
  }
  return date;
}

function normalizeBacktestTimeInput(
  rawInput: string | number,
  kind: "start" | "end",
  timeZone: string,
): BacktestNormalizedTime {
  if (typeof rawInput === "number") {
    if (!Number.isFinite(rawInput)) {
      throw new Error(`Invalid ${kind}Time: must be a finite ISO datetime, date-only value, or unix timestamp`);
    }
    const millis = Math.abs(rawInput) >= 1e12 ? Math.trunc(rawInput) : Math.trunc(rawInput * 1000);
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${kind}Time: must be a valid ISO datetime, date-only value, or unix timestamp`);
    }
    return { iso: date.toISOString(), usedExplicitOffset: false };
  }

  const value = rawInput.trim();
  if (!value) {
    throw new Error(`Invalid ${kind}Time: value is required`);
  }

  if (NUMERIC_TIMESTAMP_RE.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Invalid ${kind}Time: must be a valid unix timestamp`);
    }
    const millis = value.length >= 13 ? numeric : numeric * 1000;
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${kind}Time: must be a valid unix timestamp`);
    }
    return { iso: date.toISOString(), usedExplicitOffset: false };
  }

  if (EXPLICIT_TIMEZONE_RE.test(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${kind}Time: "${value}" is not a valid ISO datetime`);
    }
    const explicitOffset = value.match(EXPLICIT_OFFSET_CAPTURE_RE)?.[1]?.toUpperCase() ?? "Z";
    return {
      iso: date.toISOString(),
      usedExplicitOffset: true,
      explicitOffset,
    };
  }

  const dateOnly = parseDateOnly(value);
  if (dateOnly) {
    if (kind === "end") {
      dateOnly.hour = 23;
      dateOnly.minute = 59;
      dateOnly.second = 59;
      dateOnly.millisecond = 999;
    }
    return { iso: buildZonedDate(dateOnly, value, timeZone).toISOString(), usedExplicitOffset: false };
  }

  const naiveDateTime = parseNaiveDateTime(value);
  if (naiveDateTime) {
    return { iso: buildZonedDate(naiveDateTime, value, timeZone).toISOString(), usedExplicitOffset: false };
  }

  throw new Error(
    `Invalid ${kind}Time: use ISO datetime, date-only (YYYY-MM-DD), or unix timestamp`,
  );
}

function deriveBacktestTimeFromIso(
  iso: string,
  offsetMs: number,
): BacktestNormalizedTime {
  const derivedMs = new Date(iso).getTime() + offsetMs;
  const derivedDate = new Date(derivedMs);
  if (Number.isNaN(derivedDate.getTime())) {
    throw new Error(`Invalid derived backtest time from ${iso}`);
  }
  return {
    iso: derivedDate.toISOString(),
    usedExplicitOffset: false,
  };
}

function resolveNormalizedBacktestRange(
  startInput: string | number | undefined,
  endInput: string | number | undefined,
  effectiveTimeZone: string,
): {
  start: BacktestNormalizedTime;
  end: BacktestNormalizedTime;
  usedExplicitInputOffset: boolean;
  explicitOffset?: string;
} {
  if (startInput == null && endInput == null) {
    const now = new Date();
    if (Number.isNaN(now.getTime())) {
      throw new Error("Unable to resolve the current time for the default backtest window");
    }

    return {
      start: {
        iso: new Date(now.getTime() - DEFAULT_BACKTEST_WINDOW_MS).toISOString(),
        usedExplicitOffset: false,
      },
      end: {
        iso: now.toISOString(),
        usedExplicitOffset: false,
      },
      usedExplicitInputOffset: false,
    };
  }

  if (startInput == null) {
    const end = normalizeBacktestTimeInput(endInput!, "end", effectiveTimeZone);
    return {
      start: deriveBacktestTimeFromIso(end.iso, -DEFAULT_BACKTEST_WINDOW_MS),
      end,
      usedExplicitInputOffset: end.usedExplicitOffset,
      explicitOffset: end.explicitOffset,
    };
  }

  if (endInput == null) {
    const start = normalizeBacktestTimeInput(startInput, "start", effectiveTimeZone);
    return {
      start,
      end: deriveBacktestTimeFromIso(start.iso, DEFAULT_BACKTEST_WINDOW_MS),
      usedExplicitInputOffset: start.usedExplicitOffset,
      explicitOffset: start.explicitOffset,
    };
  }

  const start = normalizeBacktestTimeInput(startInput, "start", effectiveTimeZone);
  const end = normalizeBacktestTimeInput(endInput, "end", effectiveTimeZone);
  const bothExplicitOffsets = start.usedExplicitOffset && end.usedExplicitOffset;
  const sharedExplicitOffset =
    bothExplicitOffsets && start.explicitOffset === end.explicitOffset
      ? start.explicitOffset
      : undefined;

  return {
    start,
    end,
    usedExplicitInputOffset: bothExplicitOffsets,
    explicitOffset: sharedExplicitOffset,
  };
}

export function normalizeBacktestTimeRange(
  startInput?: string | number,
  endInput?: string | number,
  timeZoneOverride?: string,
): BacktestNormalizedTimeRange {
  const parsedTimeZoneOverride = resolveBacktestTimeZoneOverride(timeZoneOverride);
  const effectiveTimeZone = parsedTimeZoneOverride ?? resolveRuntimeTimeZone();
  const {
    start,
    end,
    usedExplicitInputOffset,
    explicitOffset,
  } = resolveNormalizedBacktestRange(startInput, endInput, effectiveTimeZone);

  if (new Date(start.iso).getTime() >= new Date(end.iso).getTime()) {
    throw new Error("Invalid backtest time range: startTime must be earlier than endTime");
  }

  const usesExplicitTimeZoneParameter = Boolean(parsedTimeZoneOverride);

  return {
    startTime: start.iso,
    endTime: end.iso,
    timeZoneUsed: usesExplicitTimeZoneParameter
      ? parsedTimeZoneOverride!
      : usedExplicitInputOffset
        ? explicitOffset ?? "explicit-input-offset"
        : effectiveTimeZone,
    timeZoneSource: usesExplicitTimeZoneParameter
      ? "explicit-timezone-parameter"
      : usedExplicitInputOffset
        ? "explicit-input-offset"
        : "runtime-timezone",
  };
}
