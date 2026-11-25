import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopLocalHostConfig } from "@rakazo/contracts";
import { isPrivateNetworkHost } from "@rakazo/contracts/network-host";
import { normalizeServerUrl } from "../setup/setup-config.js";
import { readPrivateFile, writePrivateFile } from "../setup/setup-store.js";

export const LOCAL_HOST_CONFIG_FILE = ".desktop-local-host.json";
const MAX_CONFIG_BYTES = 16 * 1024;
const DEFAULT_APP_IMAGE_REPO = "ghcr.io/elie222/rakazo";

const IMAGE_REPO = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/;
const IMAGE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REGION_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const DEFAULT_LOCAL_HOST_CONFIG: DesktopLocalHostConfig = {
  imageRepo: "",
  imageTag: "",
  allowLanAccess: false,
  publicOrigin: "",
  webhookPublicUrl: "",
  objectStorageBucket: "",
  objectStorageEndpoint: "",
  objectStorageRegion: "",
  objectStorageCredentialsSet: false,
  workerConcurrency: "",
  dbPoolMax: "",
};

/** Parses Compose-style `KEY=value` assignments from `.env` text; the last assignment wins. */
function parseEnvText(env: string): Map<string, string> {
  const values = new Map<string, string>();
  const assignments = env.matchAll(
    /^[\t ]*(?:export[\t ]+)?([^\s=#]+)[\t ]*=([\t ]*)(?:"((?:\\[\s\S]|[^"\\])*)"(?=[\t ]*(?:#.*)?\r?$)|'((?:\\[\s\S]|[^'\\])*)'(?=[\t ]*(?:#.*)?\r?$)|([^\r\n]*))/gm,
  );
  for (const [, name, gap = "", double, single, bare = ""] of assignments) {
    const value = double ?? single ?? (gap + bare).replace(/\s+#.*$/, "").trim();
    values.set(name!, value);
  }
  return values;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  if (hasControlChar(value)) return null;
  return value.trim();
}

function parseBoundedInt(raw: string, min: number, max: number): string | null {
  if (raw === "") return "";
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return String(parsed);
}

/** Normalizes `ghcr.io/owner/rakazo` or `ghcr.io/owner/rakazo/app` to its repository prefix. */
export function normalizeImageRepo(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  const stripped =
    trimmed.split("/").length >= 4 && trimmed.endsWith("/app")
      ? trimmed.slice(0, -"/app".length)
      : trimmed;
  if (
    stripped.length > 200 ||
    stripped.includes("..") ||
    stripped.includes("//") ||
    !IMAGE_REPO.test(stripped)
  ) {
    return null;
  }
  return stripped;
}

/**
 * Normalizes an S3-compatible endpoint URL while preserving any path prefix
 * (unlike `normalizeServerUrl`, which keeps only the origin).
 */
function normalizeEndpointUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    if (SCHEME.test(trimmed)) {
      url = new URL(trimmed);
    } else {
      const candidate = new URL(`http://${trimmed}`);
      url = isPrivateNetworkHost(candidate.hostname) ? candidate : new URL(`https://${trimmed}`);
    }
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.protocol === "http:" && !isPrivateNetworkHost(url.hostname)) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  return pathname ? `${url.origin}${pathname}` : url.origin;
}

export function parseLocalHostConfigInput(
  value: unknown,
  options: { hasStoredCredentials?: boolean } = {},
): { ok: true; value: DesktopLocalHostConfig } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "Invalid local server settings." };
  }
  const record = value as Record<string, unknown>;
  const rawRepo = readStringField(record, "imageRepo");
  const rawTag = readStringField(record, "imageTag");
  const rawPublicOrigin = readStringField(record, "publicOrigin");
  const rawWebhookUrl = readStringField(record, "webhookPublicUrl");
  const rawBucket = readStringField(record, "objectStorageBucket");
  const rawEndpoint = readStringField(record, "objectStorageEndpoint");
  const rawRegion = readStringField(record, "objectStorageRegion");
  const rawAccessKey = readStringField(record, "objectStorageAccessKeyId");
  const rawSecretKey = readStringField(record, "objectStorageSecretAccessKey");
  const rawWorkerConcurrency = readStringField(record, "workerConcurrency");
  const rawDbPoolMax = readStringField(record, "dbPoolMax");
  if (
    rawRepo === null ||
    rawTag === null ||
    rawPublicOrigin === null ||
    rawWebhookUrl === null ||
    rawBucket === null ||
    rawEndpoint === null ||
    rawRegion === null ||
    rawAccessKey === null ||
    rawSecretKey === null ||
    rawWorkerConcurrency === null ||
    rawDbPoolMax === null ||
    (record.allowLanAccess !== undefined && typeof record.allowLanAccess !== "boolean")
  ) {
    return { ok: false, error: "Invalid local server settings." };
  }

  const imageRepo = normalizeImageRepo(rawRepo);
  if (imageRepo === null) {
    return {
      ok: false,
      error: "Enter a valid container image repository, such as ghcr.io/owner/rakazo.",
    };
  }
  if (rawTag !== "" && !IMAGE_TAG.test(rawTag)) {
    return { ok: false, error: "Enter a valid container image tag, such as edge or v0.15.0." };
  }

  let publicOrigin = "";
  if (rawPublicOrigin !== "") {
    const normalized = normalizeServerUrl(rawPublicOrigin);
    if (normalized === null) {
      return {
        ok: false,
        error: "Enter a valid public or tailnet origin. Public addresses require HTTPS.",
      };
    }
    publicOrigin = normalized;
  }

  let webhookPublicUrl = "";
  if (rawWebhookUrl !== "") {
    const normalized = normalizeServerUrl(rawWebhookUrl);
    if (normalized === null || !normalized.startsWith("https://")) {
      return { ok: false, error: "Webhook ingress URL must be a valid https:// address." };
    }
    webhookPublicUrl = normalized;
  }

  if (rawBucket !== "" && !BUCKET_NAME.test(rawBucket)) {
    return { ok: false, error: "Enter a valid object storage bucket name." };
  }
  let objectStorageEndpoint = "";
  if (rawEndpoint !== "") {
    const normalized = normalizeEndpointUrl(rawEndpoint);
    if (normalized === null) {
      return { ok: false, error: "Enter a valid object storage endpoint URL." };
    }
    objectStorageEndpoint = normalized;
  }
  if (rawRegion !== "" && !REGION_NAME.test(rawRegion)) {
    return { ok: false, error: "Enter a valid object storage region." };
  }
  if (rawAccessKey.length > 256 || rawSecretKey.length > 256) {
    return { ok: false, error: "Object storage credentials are too long." };
  }
  const hasAnyStorage =
    rawBucket !== "" ||
    objectStorageEndpoint !== "" ||
    rawRegion !== "" ||
    rawAccessKey !== "" ||
    rawSecretKey !== "";
  if (hasAnyStorage && (rawBucket === "" || objectStorageEndpoint === "")) {
    return {
      ok: false,
      error: "Enter both a bucket and an endpoint URL to configure object storage.",
    };
  }
  if ((rawAccessKey !== "") !== (rawSecretKey !== "")) {
    return {
      ok: false,
      error: "Enter both the access key ID and secret access key together.",
    };
  }
  if (hasAnyStorage && !rawAccessKey && !rawSecretKey && !options.hasStoredCredentials) {
    return {
      ok: false,
      error: "Enter an access key ID and secret access key to configure object storage.",
    };
  }

  const workerConcurrency = parseBoundedInt(rawWorkerConcurrency, 1, 64);
  if (workerConcurrency === null) {
    return { ok: false, error: "Worker concurrency must be a whole number between 1 and 64." };
  }
  const dbPoolMax = parseBoundedInt(rawDbPoolMax, 6, 100);
  if (dbPoolMax === null) {
    return { ok: false, error: "Database pool size must be a whole number between 6 and 100." };
  }

  return {
    ok: true,
    value: {
      imageRepo,
      imageTag: rawTag,
      allowLanAccess: record.allowLanAccess === true,
      publicOrigin,
      webhookPublicUrl,
      objectStorageBucket: rawBucket,
      objectStorageEndpoint,
      objectStorageRegion: rawRegion,
      ...(rawAccessKey ? { objectStorageAccessKeyId: rawAccessKey } : {}),
      ...(rawSecretKey ? { objectStorageSecretAccessKey: rawSecretKey } : {}),
      workerConcurrency,
      dbPoolMax,
    },
  };
}

interface StoredLocalHostMeta {
  imageRepo?: string;
  imageTag?: string;
  allowLanAccess?: boolean;
  publicOrigin?: string;
  webhookPublicUrl?: string;
}

async function readStoredMeta(dir: string): Promise<StoredLocalHostMeta | null> {
  const raw = await readPrivateFile(path.join(dir, LOCAL_HOST_CONFIG_FILE), MAX_CONFIG_BYTES);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredLocalHostMeta) : null;
  } catch {
    return null;
  }
}

export async function hasCustomLocalHostConfig(dir: string): Promise<boolean> {
  return (await readStoredMeta(dir)) !== null;
}

/**
 * Reads the editable local host settings from `.desktop-local-host.json` and `.env`.
 * Never returns secret values; only reports whether object storage credentials are set.
 */
export async function readLocalHostConfig(dir: string): Promise<DesktopLocalHostConfig> {
  const [meta, rawEnv] = await Promise.all([
    readStoredMeta(dir),
    readPrivateFile(path.join(dir, ".env"), 256 * 1024),
  ]);
  const env = rawEnv ? parseEnvText(rawEnv) : new Map<string, string>();
  const envImage = env.get("RAKAZO_IMAGE") ?? "";
  const envRepo =
    envImage && envImage !== `${DEFAULT_APP_IMAGE_REPO}/app`
      ? (normalizeImageRepo(envImage) ?? "")
      : "";
  const imageRepo =
    typeof meta?.imageRepo === "string" ? (normalizeImageRepo(meta.imageRepo) ?? "") : envRepo;
  const imageTag =
    typeof meta?.imageTag === "string" && IMAGE_TAG.test(meta.imageTag) ? meta.imageTag : "";
  const allowLanAccess =
    typeof meta?.allowLanAccess === "boolean"
      ? meta.allowLanAccess
      : env.get("RAKAZO_WEB_BIND") === "0.0.0.0";
  const publicOrigin =
    typeof meta?.publicOrigin === "string" ? (normalizeServerUrl(meta.publicOrigin) ?? "") : "";
  const webhookPublicUrl =
    typeof meta?.webhookPublicUrl === "string" &&
    (normalizeServerUrl(meta.webhookPublicUrl)?.startsWith("https://") ?? false)
      ? (normalizeServerUrl(meta.webhookPublicUrl) ?? "")
      : env.get("INGRESS_PROVIDER") === "manual"
        ? (normalizeServerUrl(env.get("INGRESS_PUBLIC_URL") ?? "") ?? "")
        : "";
  const objectStorageBucket = env.get("OBJECT_STORAGE_BUCKET") ?? "";
  const objectStorageEndpoint = env.get("OBJECT_STORAGE_ENDPOINT") ?? "";
  const objectStorageRegion = env.get("OBJECT_STORAGE_REGION") ?? "";
  const objectStorageCredentialsSet = Boolean(
    env.get("OBJECT_STORAGE_ACCESS_KEY_ID") && env.get("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
  );
  const workerConcurrency =
    parseBoundedInt(env.get("GRAPHILE_WORKER_CONCURRENCY") ?? "", 1, 64) ?? "";
  const dbPoolMax = parseBoundedInt(env.get("DB_POOL_MAX") ?? "", 6, 100) ?? "";

  return {
    imageRepo,
    imageTag,
    allowLanAccess,
    publicOrigin,
    webhookPublicUrl,
    objectStorageBucket,
    objectStorageEndpoint,
    objectStorageRegion,
    objectStorageCredentialsSet,
    workerConcurrency,
    dbPoolMax,
  };
}

function formatEnvValue(value: string): string {
  if (value === "") return "";
  if (!/[\s#$"'\\]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

/**
 * Updates managed keys inside `.env` while keeping comments, line order, generated secrets, and
 * unrelated manual edits intact.
 */
export function updateEnvEntries(envText: string, updates: Record<string, string>): string {
  const keys = new Set(Object.keys(updates));
  const seen = new Set<string>();
  const trailingNewline = envText.endsWith("\n");
  const lines = (trailingNewline ? envText.slice(0, -1) : envText).split("\n");
  const nextLines = lines.map((line) => {
    const match = /^([\t ]*(?:export[\t ]+)?)([^\s=#]+)[\t ]*=/.exec(line);
    if (!match) return line;
    const [, prefix, name] = match;
    if (!name || !keys.has(name)) return line;
    seen.add(name);
    return `${prefix}${name}=${formatEnvValue(updates[name] ?? "")}`;
  });
  for (const [name, value] of Object.entries(updates)) {
    if (seen.has(name) || value === "") continue;
    nextLines.push(`${name}=${formatEnvValue(value)}`);
  }
  return `${nextLines.join("\n")}${trailingNewline || envText === "" ? "\n" : ""}`;
}

/**
 * Persists validated local host settings to `.desktop-local-host.json` and the stack `.env`.
 * Callers must ensure `.env` has been initialized first.
 */
export async function writeLocalHostConfig(
  dir: string,
  config: DesktopLocalHostConfig,
): Promise<DesktopLocalHostConfig> {
  const envPath = path.join(dir, ".env");
  const currentEnv = await readFile(envPath, "utf8");
  const storageEnabled = Boolean(config.objectStorageBucket && config.objectStorageEndpoint);
  const envUpdates: Record<string, string> = {
    RAKAZO_IMAGE: config.imageRepo ? `${config.imageRepo}/app` : `${DEFAULT_APP_IMAGE_REPO}/app`,
    RAKAZO_COMPUTER_IMAGE: config.imageRepo
      ? `${config.imageRepo}/computer`
      : `${DEFAULT_APP_IMAGE_REPO}/computer`,
    RAKAZO_WEB_BIND: config.allowLanAccess ? "0.0.0.0" : "127.0.0.1",
    INGRESS_PROVIDER: config.webhookPublicUrl ? "manual" : "",
    INGRESS_PUBLIC_URL: config.webhookPublicUrl,
    OBJECT_STORAGE_BUCKET: storageEnabled ? config.objectStorageBucket : "",
    OBJECT_STORAGE_PROTOCOL: storageEnabled ? "s3" : "",
    OBJECT_STORAGE_ENDPOINT: storageEnabled ? config.objectStorageEndpoint : "",
    OBJECT_STORAGE_REGION: storageEnabled ? config.objectStorageRegion || "auto" : "",
    GRAPHILE_WORKER_CONCURRENCY: config.workerConcurrency,
    DB_POOL_MAX: config.dbPoolMax,
  };
  if (!storageEnabled) {
    envUpdates.OBJECT_STORAGE_ACCESS_KEY_ID = "";
    envUpdates.OBJECT_STORAGE_SECRET_ACCESS_KEY = "";
  } else if (config.objectStorageAccessKeyId && config.objectStorageSecretAccessKey) {
    envUpdates.OBJECT_STORAGE_ACCESS_KEY_ID = config.objectStorageAccessKeyId;
    envUpdates.OBJECT_STORAGE_SECRET_ACCESS_KEY = config.objectStorageSecretAccessKey;
  }

  await writePrivateFile(envPath, updateEnvEntries(currentEnv, envUpdates));
  const meta: StoredLocalHostMeta = {
    imageRepo: config.imageRepo,
    imageTag: config.imageTag,
    allowLanAccess: config.allowLanAccess,
    publicOrigin: config.publicOrigin,
    webhookPublicUrl: config.webhookPublicUrl,
  };
  await writePrivateFile(
    path.join(dir, LOCAL_HOST_CONFIG_FILE),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  return readLocalHostConfig(dir);
}

/**
 * Translates local host config into Compose launch environment overrides.
 * When `publicOrigin` is set, keeps the desktop app's loopback origin trusted via
 * `RAKAZO_ALLOWED_HOSTS` and `RAKAZO_EXTRA_AUTH_ORIGINS` so the local app never locks itself out.
 */
export function localHostComposeEnv(
  config: DesktopLocalHostConfig,
  localWebUrl: string,
  defaultImageTag: string,
): { imageTag: string; env: Record<string, string> } {
  const imageTag = config.imageTag || defaultImageTag;
  const primaryOrigin = config.publicOrigin || localWebUrl;
  const env: Record<string, string> = {
    RAKAZO_IMAGE_TAG: imageTag,
    RAKAZO_COMPUTER_IMAGE_TAG: imageTag,
    BETTER_AUTH_URL: primaryOrigin,
    WEB_ORIGIN: primaryOrigin,
    API_URL: primaryOrigin,
  };
  if (config.imageRepo) {
    env.RAKAZO_IMAGE = `${config.imageRepo}/app`;
    env.RAKAZO_COMPUTER_IMAGE = `${config.imageRepo}/computer`;
  }
  if (config.allowLanAccess) {
    env.RAKAZO_WEB_BIND = "0.0.0.0";
  }
  if (config.publicOrigin) {
    env.RAKAZO_HOST = new URL(config.publicOrigin).hostname;
    env.RAKAZO_ALLOWED_HOSTS = "localhost,127.0.0.1";
    env.RAKAZO_EXTRA_AUTH_ORIGINS = localWebUrl;
  }
  if (config.webhookPublicUrl) {
    env.INGRESS_PROVIDER = "manual";
    env.INGRESS_PUBLIC_URL = config.webhookPublicUrl;
  }
  return { imageTag, env };
}

export function localHostConfigFingerprint(config: DesktopLocalHostConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        imageRepo: config.imageRepo,
        imageTag: config.imageTag,
        allowLanAccess: config.allowLanAccess,
        publicOrigin: config.publicOrigin,
        webhookPublicUrl: config.webhookPublicUrl,
        objectStorageBucket: config.objectStorageBucket,
        objectStorageEndpoint: config.objectStorageEndpoint,
        objectStorageRegion: config.objectStorageRegion,
        objectStorageCredentialsSet: Boolean(config.objectStorageCredentialsSet),
        workerConcurrency: config.workerConcurrency,
        dbPoolMax: config.dbPoolMax,
      }),
    )
    .digest("hex");
}
