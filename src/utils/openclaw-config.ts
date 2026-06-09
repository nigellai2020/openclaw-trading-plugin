import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PRIMARY_CONFIG_FILE_NAME = "openclaw.json";

function readConfigFile(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function getOpenClawDir(): string {
  return path.join(os.homedir(), ".openclaw");
}

export function getOpenClawConfigPath(openclawDir = getOpenClawDir()): string {
  return path.join(openclawDir, PRIMARY_CONFIG_FILE_NAME);
}

export function readOpenClawConfig(openclawDir = getOpenClawDir()): Record<string, unknown> {
  return readConfigFile(getOpenClawConfigPath(openclawDir));
}

export function writeOpenClawConfig(
  config: Record<string, unknown>,
  openclawDir = getOpenClawDir(),
): void {
  fs.mkdirSync(openclawDir, { recursive: true });
  const serialized = JSON.stringify(config, null, 2) + "\n";
  fs.writeFileSync(getOpenClawConfigPath(openclawDir), serialized);
}
