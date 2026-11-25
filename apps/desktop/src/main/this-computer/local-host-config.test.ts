import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_HOST_CONFIG,
  localHostComposeEnv,
  parseLocalHostConfigInput,
  readLocalHostConfig,
  updateEnvEntries,
  writeLocalHostConfig,
} from "./local-host-config.js";

describe("parseLocalHostConfigInput", () => {
  it("normalizes valid hosting settings including /app suffix on imageRepo", () => {
    const parsed = parseLocalHostConfigInput({
      imageRepo: "ghcr.io/example-org/rakazo/app/",
      imageTag: "edge",
      allowLanAccess: true,
      publicOrigin: "rakazo.example.com/path",
      webhookPublicUrl: "https://hooks.example.com/",
      objectStorageBucket: "rakazo-data",
      objectStorageEndpoint: "https://storage.example.com",
      objectStorageRegion: "auto",
      objectStorageAccessKeyId: "ak_test",
      objectStorageSecretAccessKey: "sk_test",
      workerConcurrency: "2",
      dbPoolMax: "12",
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        imageRepo: "ghcr.io/example-org/rakazo",
        imageTag: "edge",
        allowLanAccess: true,
        publicOrigin: "https://rakazo.example.com",
        webhookPublicUrl: "https://hooks.example.com",
        objectStorageBucket: "rakazo-data",
        objectStorageEndpoint: "https://storage.example.com",
        objectStorageRegion: "auto",
        objectStorageAccessKeyId: "ak_test",
        objectStorageSecretAccessKey: "sk_test",
        workerConcurrency: "2",
        dbPoolMax: "12",
      },
    });
  });

  it.each([
    ["an invalid image repository", { imageRepo: "GHCR.IO/Bad Repo" }],
    ["an invalid image tag", { imageTag: "edge;rm -rf /" }],
    ["a cleartext public origin", { publicOrigin: "http://example.com" }],
    ["a non-HTTPS webhook URL", { webhookPublicUrl: "http://127.0.0.1:3101" }],
    ["partial object storage without endpoint", { objectStorageBucket: "only-bucket" }],
    [
      "one-sided object storage credentials",
      {
        objectStorageBucket: "bucket",
        objectStorageEndpoint: "https://storage.example.com",
        objectStorageAccessKeyId: "key-only",
      },
    ],
    ["out-of-range worker concurrency", { workerConcurrency: "99" }],
    ["non-numeric database pool size", { dbPoolMax: "abc" }],
  ])("rejects %s", (_label, patch) => {
    const parsed = parseLocalHostConfigInput({ ...DEFAULT_LOCAL_HOST_CONFIG, ...patch });
    expect(parsed.ok).toBe(false);
  });
});

describe("updateEnvEntries and persistence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rakazo-local-host-cfg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("updates managed keys while preserving secrets, comments and quoting special characters", () => {
    const original = [
      "# Generated secrets",
      "POSTGRES_PASSWORD=keep-secret",
      "RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app",
      "OBJECT_STORAGE_SECRET_ACCESS_KEY=",
      "",
    ].join("\n");
    const updated = updateEnvEntries(original, {
      RAKAZO_IMAGE: "ghcr.io/example-org/rakazo/app",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "sec#ret$1",
      GRAPHILE_WORKER_CONCURRENCY: "2",
    });
    expect(updated).toContain("# Generated secrets\nPOSTGRES_PASSWORD=keep-secret\n");
    expect(updated).toContain("RAKAZO_IMAGE=ghcr.io/example-org/rakazo/app\n");
    expect(updated).toContain("OBJECT_STORAGE_SECRET_ACCESS_KEY='sec#ret$1'\n");
    expect(updated).toContain("GRAPHILE_WORKER_CONCURRENCY=2\n");
  });

  it("writes config to .env and metadata without returning secrets on read", async () => {
    await writeFile(
      path.join(dir, ".env"),
      [
        "POSTGRES_PASSWORD=secret-pg",
        "RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app",
        "RAKAZO_COMPUTER_IMAGE=ghcr.io/elie222/rakazo/computer",
        "RAKAZO_WEB_BIND=127.0.0.1",
        "OBJECT_STORAGE_BUCKET=",
        "OBJECT_STORAGE_PROTOCOL=",
        "OBJECT_STORAGE_ENDPOINT=",
        "OBJECT_STORAGE_REGION=",
        "OBJECT_STORAGE_ACCESS_KEY_ID=",
        "OBJECT_STORAGE_SECRET_ACCESS_KEY=",
        "",
      ].join("\n"),
    );

    const saved = await writeLocalHostConfig(dir, {
      ...DEFAULT_LOCAL_HOST_CONFIG,
      imageRepo: "ghcr.io/example-org/rakazo",
      imageTag: "edge",
      allowLanAccess: true,
      publicOrigin: "https://pc.example.ts.net",
      webhookPublicUrl: "https://hooks.example.com",
      objectStorageBucket: "my-bucket",
      objectStorageEndpoint: "https://r2.example.com",
      objectStorageRegion: "auto",
      objectStorageAccessKeyId: "ak_123",
      objectStorageSecretAccessKey: "sk_456",
      workerConcurrency: "2",
      dbPoolMax: "12",
    });

    expect(saved).toEqual({
      imageRepo: "ghcr.io/example-org/rakazo",
      imageTag: "edge",
      allowLanAccess: true,
      publicOrigin: "https://pc.example.ts.net",
      webhookPublicUrl: "https://hooks.example.com",
      objectStorageBucket: "my-bucket",
      objectStorageEndpoint: "https://r2.example.com",
      objectStorageRegion: "auto",
      objectStorageCredentialsSet: true,
      workerConcurrency: "2",
      dbPoolMax: "12",
    });
    expect(saved.objectStorageAccessKeyId).toBeUndefined();
    expect(saved.objectStorageSecretAccessKey).toBeUndefined();

    const env = await readFile(path.join(dir, ".env"), "utf8");
    expect(env).toContain("POSTGRES_PASSWORD=secret-pg");
    expect(env).toContain("OBJECT_STORAGE_PROTOCOL=s3");
    expect(env).toContain("OBJECT_STORAGE_ACCESS_KEY_ID=ak_123");
    expect(env).toContain("OBJECT_STORAGE_SECRET_ACCESS_KEY=sk_456");

    // Re-saving without re-entering credentials keeps them stored.
    const kept = await writeLocalHostConfig(dir, {
      ...saved,
      workerConcurrency: "4",
    });
    expect(kept.objectStorageCredentialsSet).toBe(true);
    expect(kept.workerConcurrency).toBe("4");
    expect(await readLocalHostConfig(dir)).toEqual(kept);
  });
});

describe("localHostComposeEnv", () => {
  it("keeps loopback origins trusted alongside a custom public origin and fork image", () => {
    const result = localHostComposeEnv(
      {
        ...DEFAULT_LOCAL_HOST_CONFIG,
        imageRepo: "ghcr.io/example-org/rakazo",
        imageTag: "edge",
        allowLanAccess: true,
        publicOrigin: "https://pc.example.ts.net",
        webhookPublicUrl: "https://hooks.example.com",
      },
      "http://127.0.0.1:45173",
      "v0.15.0",
    );
    expect(result).toEqual({
      imageTag: "edge",
      env: {
        RAKAZO_IMAGE: "ghcr.io/example-org/rakazo/app",
        RAKAZO_COMPUTER_IMAGE: "ghcr.io/example-org/rakazo/computer",
        RAKAZO_IMAGE_TAG: "edge",
        RAKAZO_COMPUTER_IMAGE_TAG: "edge",
        RAKAZO_WEB_BIND: "0.0.0.0",
        BETTER_AUTH_URL: "https://pc.example.ts.net",
        WEB_ORIGIN: "https://pc.example.ts.net",
        API_URL: "https://pc.example.ts.net",
        RAKAZO_HOST: "pc.example.ts.net",
        RAKAZO_ALLOWED_HOSTS: "localhost,127.0.0.1",
        RAKAZO_EXTRA_AUTH_ORIGINS: "http://127.0.0.1:45173",
        INGRESS_PROVIDER: "manual",
        INGRESS_PUBLIC_URL: "https://hooks.example.com",
      },
    });
  });
});
