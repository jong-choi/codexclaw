import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME, CONFIG_VERSION } from "./constants.mjs";

function normalizePath(customPath) {
  if (customPath && String(customPath).trim()) {
    return path.resolve(String(customPath).trim());
  }
  return path.join(os.homedir(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export function resolveConfigPath(customPath) {
  return normalizePath(customPath);
}

export async function loadConfig(customPath) {
  const filePath = normalizePath(customPath);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { path: filePath, config: null };
    }
    return { path: filePath, config: parsed };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { path: filePath, config: null };
    }
    throw error;
  }
}

export async function saveConfig(config, customPath) {
  const filePath = normalizePath(customPath);
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });

  const next = {
    version: CONFIG_VERSION,
    ...config,
    updatedAt: new Date().toISOString(),
  };

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
  return { path: filePath, config: next };
}
