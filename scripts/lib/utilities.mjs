import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export function requireEnvironmentVariable(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Required environment variable ${name} is missing.`
    );
  }

  return value;
}

export function parseBoolean(
  value,
  defaultValue = false
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return defaultValue;
  }

  const normalized = String(value)
    .trim()
    .toLowerCase();

  if (
    ["true", "1", "yes", "y"].includes(normalized)
  ) {
    return true;
  }

  if (
    ["false", "0", "no", "n"].includes(normalized)
  ) {
    return false;
  }

  throw new Error(
    `Unable to parse Boolean value: ${value}`
  );
}

export async function writeJson(
  filePath,
  value
) {
  await fs.mkdir(
    path.dirname(filePath),
    {
      recursive: true
    }
  );

  const stableValue = stableSortObject(value);

  await fs.writeFile(
    filePath,
    `${JSON.stringify(stableValue, null, 2)}\n`,
    "utf8"
  );
}

export function stableSortObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) =>
          item !== undefined
        )
        .sort(([keyA], [keyB]) =>
          keyA.localeCompare(keyB)
        )
        .map(([key, item]) => [
          key,
          stableSortObject(item)
        ])
    );
  }

  return value;
}

export function cleanUndefined(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => item !== undefined)
      .map(cleanUndefined);
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) =>
          item !== undefined
        )
        .map(([key, item]) => [
          key,
          cleanUndefined(item)
        ])
    );
  }

  return value;
}

export function sha256(value) {
  const content =
    typeof value === "string"
      ? value
      : JSON.stringify(
          stableSortObject(value)
        );

  return crypto
    .createHash("sha256")
    .update(content)
    .digest("hex");
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function replaceDirectoryAtomically({
  temporaryPath,
  finalPath,
  backupPath
}) {
  const finalExists =
    await pathExists(finalPath);

  if (finalExists) {
    await fs.rename(
      finalPath,
      backupPath
    );
  }

  try {
    await fs.mkdir(
      path.dirname(finalPath),
      {
        recursive: true
      }
    );

    await fs.rename(
      temporaryPath,
      finalPath
    );

    await fs.rm(
      backupPath,
      {
        recursive: true,
        force: true
      }
    );
  } catch (error) {
    await fs.rm(
      finalPath,
      {
        recursive: true,
        force: true
      }
    );

    if (await pathExists(backupPath)) {
      await fs.rename(
        backupPath,
        finalPath
      );
    }

    throw error;
  }
}

export function getParentFolderId(folder) {
  const parent = folder.parent_folder;

  if (parent == null) {
    return null;
  }

  if (
    typeof parent === "string" ||
    typeof parent === "number"
  ) {
    return String(parent);
  }

  if (parent.id != null) {
    return String(parent.id);
  }

  return null;
}