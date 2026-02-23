import fs from "node:fs/promises";
import path from "node:path";
import {
  WORKSPACE_DEFAULT_ROOT_DIR,
  WORKSPACE_INSTRUCTIONS_FILE_NAME,
  WORKSPACE_MEMORY_FILE_NAME,
  WORKSPACE_TEMPLATE_ROOT_DIR,
} from "./constants.mjs";

function trim(value) {
  return String(value ?? "").trim();
}

export function resolveWorkspaceRoot(rawValue) {
  const fromParam = trim(rawValue);
  if (fromParam) {
    return path.resolve(fromParam);
  }
  return path.resolve(process.cwd(), WORKSPACE_DEFAULT_ROOT_DIR);
}

export function resolveWorkspaceTemplateRoot(rawValue) {
  const fromParam = trim(rawValue);
  if (fromParam) {
    return path.resolve(fromParam);
  }
  return path.resolve(process.cwd(), WORKSPACE_TEMPLATE_ROOT_DIR);
}

async function copyTemplateContents(templateRoot, workspaceRoot) {
  let entries = [];
  try {
    entries = await fs.readdir(templateRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        copiedEntries: 0,
      };
    }
    throw error;
  }

  for (const entry of entries) {
    const source = path.join(templateRoot, entry.name);
    const destination = path.join(workspaceRoot, entry.name);
    await fs.cp(source, destination, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }

  return {
    copiedEntries: entries.length,
  };
}

export async function inspectWorkspace(options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const templateRoot = resolveWorkspaceTemplateRoot(options.templateRoot);

  try {
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${workspaceRoot}`);
    }
    const entries = await fs.readdir(workspaceRoot);
    return {
      workspaceRoot,
      templateRoot,
      exists: true,
      entryCount: entries.length,
      populated: entries.length > 0,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        workspaceRoot,
        templateRoot,
        exists: false,
        entryCount: 0,
        populated: false,
      };
    }
    throw error;
  }
}

export async function ensureWorkspaceInitialized(options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const templateRoot = resolveWorkspaceTemplateRoot(options.templateRoot);
  const forceReset = Boolean(options.forceReset);

  if (forceReset) {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
  await fs.mkdir(workspaceRoot, { recursive: true });
  let existingEntries = [];
  try {
    existingEntries = await fs.readdir(workspaceRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  let seededFromTemplate = false;
  if (forceReset || existingEntries.length === 0) {
    const copied = await copyTemplateContents(templateRoot, workspaceRoot);
    seededFromTemplate = copied.copiedEntries > 0;
  }

  const memoryPath = path.join(workspaceRoot, WORKSPACE_MEMORY_FILE_NAME);
  const instructionsPath = path.join(workspaceRoot, WORKSPACE_INSTRUCTIONS_FILE_NAME);
  await fs.writeFile(memoryPath, "", { flag: "a" });
  await fs.writeFile(instructionsPath, "", { flag: "a" });

  return {
    workspaceRoot,
    templateRoot,
    seededFromTemplate,
    forceReset,
    memoryPath,
    instructionsPath,
  };
}
