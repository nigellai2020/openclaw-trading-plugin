type JsonRecord = Record<string, unknown>;

const NUMBER_LITERAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const XMLISH_NODE_RE = /^<([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/\1>/;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwnField(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function unwrapWhenTransportWrappers(value: string): string {
  let unwrapped = value.trim();
  let previous = "";

  while (unwrapped !== previous) {
    previous = unwrapped;
    unwrapped = unwrapped.replace(/^<when(?:\s[^>]*)?>/i, "").trimStart();
    unwrapped = unwrapped.replace(/<\/when>\s*$/i, "").trimEnd();
    unwrapped = unwrapped.replace(/^<!\[CDATA\[/i, "").trimStart();
    unwrapped = unwrapped.replace(/\]\]>\s*$/i, "").trimEnd();
  }

  return decodeXmlEntities(unwrapped).trim();
}

function coerceScalarString(value: string): unknown {
  const trimmed = decodeXmlEntities(value).trim();
  if (trimmed.length === 0) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (NUMBER_LITERAL_RE.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function tryParseStructuredWhenString(value: string): unknown | undefined {
  const unwrapped = unwrapWhenTransportWrappers(value);
  if (!unwrapped) return undefined;

  try {
    const parsed = JSON.parse(unwrapped) as unknown;
    if (typeof parsed !== "string") {
      return parsed;
    }
  } catch {}

  return tryParseXmlishSequence(unwrapped);
}

function tryParseXmlishSequence(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("<")) return undefined;

  const nodes: Array<{ name: string; value: unknown }> = [];
  let cursor = 0;

  while (cursor < trimmed.length) {
    const remaining = trimmed.slice(cursor);
    const match = XMLISH_NODE_RE.exec(remaining);
    if (!match?.[0] || !match[1]) {
      return undefined;
    }

    const inner = match[2] ?? "";
    const parsedInner = tryParseStructuredWhenString(inner);
    nodes.push({
      name: match[1],
      value: parsedInner === undefined ? coerceScalarString(inner) : parsedInner,
    });
    cursor += match[0].length;
    while (/\s/.test(trimmed[cursor] ?? "")) {
      cursor += 1;
    }
  }

  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) {
    return { [nodes[0].name]: nodes[0].value };
  }

  const allSameName = nodes.every((node) => node.name === nodes[0].name);
  if (allSameName) {
    return nodes.map((node) => node.value);
  }

  const grouped: Record<string, unknown[]> = {};
  for (const node of nodes) {
    grouped[node.name] ??= [];
    grouped[node.name].push(node.value);
  }

  const result: JsonRecord = {};
  for (const [name, values] of Object.entries(grouped)) {
    result[name] = values.length === 1 ? values[0] : values;
  }
  return result;
}

export function normalizeStrategyRuleWhens<T extends JsonRecord>(strategy: T): T {
  const rules = strategy.rules;
  if (!Array.isArray(rules)) return strategy;

  let changed = false;
  const nextRules = rules.map((rule) => {
    if (!isRecord(rule) || !hasOwnField(rule, "when") || typeof rule.when !== "string") {
      return rule;
    }

    const normalizedWhen = tryParseStructuredWhenString(rule.when);
    if (normalizedWhen === undefined) {
      return rule;
    }

    changed = true;
    return {
      ...rule,
      when: normalizedWhen,
    };
  });

  if (!changed) return strategy;
  return {
    ...strategy,
    rules: nextRules,
  } as T;
}