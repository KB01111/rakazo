import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DesktopLocalStackState } from "@rakazo/contracts";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appWindowTargets, desktop } from "../desktop-state.js";
import type { IpcCaller } from "../ipc/ipc.js";
import { RAKAZO_CLOUD_URL } from "../setup/setup-config.js";
import { broadcastLocalStackState, registerServerIpc } from "./local-host-ipc.js";
import { STACK_ENV_FILE, STACK_ENV_TEMPLATE } from "./local-stack.js";

type Listener = (event: IpcCaller, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({
  invoke: new Map<string, Listener>(),
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(),
  showSetupWindow: vi.fn(),
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
  setLoginItemSettings: vi.fn(),
  openPath: vi.fn<(target: string) => Promise<string>>(async () => ""),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => mocks.invoke.set(channel, listener),
    on: vi.fn(),
  },
  app: {
    getLoginItemSettings: () => mocks.getLoginItemSettings(),
    setLoginItemSettings: (settings: unknown) => mocks.setLoginItemSettings(settings),
  },
  dialog: { showMessageBox: (...args: unknown[]) => mocks.showMessageBox(...args) },
  shell: { openPath: (target: string) => mocks.openPath(target) },
}));
vi.mock("../system/monitoring.js", () => ({ reportDesktopError: vi.fn() }));
vi.mock("../setup/setup-window.js", () => ({
  showSetupWindow: (...args: unknown[]) => mocks.showSetupWindow(...args),
}));

const LOCAL_URL = "http://127.0.0.1:45173";

function fakeAppWindow(url: string) {
  const frame = { url };
  const send = vi.fn();
  const webContents = { mainFrame: frame, isDestroyed: () => false, send };
  const win = {
    isDestroyed: () => false,
    webContents,
  } as unknown as BrowserWindow;
  appWindowTargets.set(win, url);
  return {
    win,
    send,
    event: { sender: webContents, senderFrame: frame } as unknown as IpcCaller,
  };
}

let root: string;
let stackDir: string;
let resourceDir: string;
let stackState: DesktopLocalStackState;
const startStack = vi.fn();
const stopStack = vi.fn();
const settleLocalStack = vi.fn();
const installApplicationMenu = vi.fn();

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rakazo-server-ipc-"));
  stackDir = path.join(root, "stack");
  resourceDir = path.join(root, "resources");
  await mkdir(resourceDir, { recursive: true });
  await writeFile(
    path.join(resourceDir, STACK_ENV_TEMPLATE),
    "POSTGRES_PASSWORD=\nRAKAZO_IMAGE=ghcr.io/elie222/rakazo/app\nRAKAZO_WEB_BIND=127.0.0.1\n",
  );
  mocks.invoke.clear();
  mocks.showMessageBox.mockReset().mockResolvedValue({ response: 0 });
  mocks.showSetupWindow.mockReset().mockReturnValue({ reload: vi.fn(), isDestroyed: () => false });
  mocks.getLoginItemSettings.mockReset().mockReturnValue({ openAtLogin: false });
  mocks.setLoginItemSettings.mockReset();
  mocks.openPath.mockReset().mockResolvedValue("");
  stackState = { phase: "idle", message: null, output: [], layerBytes: {}, imageTag: "edge" };
  startStack.mockReset().mockImplementation(async () => stackState);
  stopStack.mockReset().mockImplementation(async () => stackState);
  settleLocalStack.mockReset().mockResolvedValue(undefined);
  installApplicationMenu.mockReset();
  desktop.autoStartLocalSetup = false;
  desktop.setupWindow = null;
  desktop.localStack = {
    webUrl: () => LOCAL_URL,
    state: () => stackState,
    matchesDesiredStack: vi.fn(async () => false),
    managedStackRunning: () => stackState.phase === "ready",
    start: startStack,
    stop: stopStack,
    abort: vi.fn(),
  };
  registerServerIpc({
    userStackDir: stackDir,
    resourceDir,
    randomHex: (bytes) => "ab".repeat(bytes),
    settleLocalStack,
    installApplicationMenu,
  });
});

afterEach(async () => {
  desktop.mainWindow = null;
  desktop.currentSetup = null;
  desktop.currentTargetUrl = null;
  desktop.autoStartLocalSetup = false;
  await rm(root, { recursive: true, force: true });
});

describe("desktop server IPC", () => {
  it("starts local hosting in one click from Rakazo Cloud without leaking local config", async () => {
    const appWin = fakeAppWindow(RAKAZO_CLOUD_URL);
    desktop.mainWindow = appWin.win;
    desktop.currentSetup = { mode: "existing", serverUrl: RAKAZO_CLOUD_URL };
    desktop.currentTargetUrl = RAKAZO_CLOUD_URL;

    const state = await mocks.invoke.get("desktop.server.state")?.(appWin.event);
    expect(state).toMatchObject({
      kind: "cloud",
      serverUrl: RAKAZO_CLOUD_URL,
      localConfig: null,
      startOnLoginSupported: false,
    });

    await mocks.invoke.get("desktop.server.hostLocally")?.(appWin.event);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(desktop.autoStartLocalSetup).toBe(true);
    expect(settleLocalStack).toHaveBeenCalledOnce();
    expect(startStack).toHaveBeenCalledOnce();
    expect(mocks.showSetupWindow).toHaveBeenCalledOnce();
  });

  it("asks native confirmation before hosting locally from a third-party server and refuses local writes", async () => {
    const remoteUrl = "https://team.example.com";
    const appWin = fakeAppWindow(remoteUrl);
    desktop.mainWindow = appWin.win;
    desktop.currentSetup = { mode: "existing", serverUrl: remoteUrl };
    desktop.currentTargetUrl = remoteUrl;
    stackState = {
      phase: "failed",
      message: "Docker failed",
      output: ["/private/local/path"],
      layerBytes: {},
      imageTag: "edge",
    };

    const remoteState = await mocks.invoke.get("desktop.server.state")?.(appWin.event);
    expect(remoteState).toMatchObject({
      kind: "existing",
      localWebUrl: "",
      localStackRunning: false,
      localStack: { phase: "idle", message: null, output: [] },
      localConfig: null,
    });

    broadcastLocalStackState(stackState);
    expect(appWin.send).not.toHaveBeenCalled();

    await mocks.invoke.get("desktop.server.hostLocally")?.(appWin.event);
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    expect(startStack).not.toHaveBeenCalled();

    const saveResult = await mocks.invoke.get("desktop.server.saveLocalConfig")?.(appWin.event, {
      imageRepo: "ghcr.io/example-org/rakazo",
      imageTag: "edge",
      allowLanAccess: false,
      publicOrigin: "",
      webhookPublicUrl: "",
      objectStorageBucket: "",
      objectStorageEndpoint: "",
      objectStorageRegion: "",
      workerConcurrency: "",
      dbPoolMax: "",
    });
    expect(saveResult).toMatchObject({ ok: false });
    expect(await mocks.invoke.get("desktop.server.stopLocal")?.(appWin.event)).toBeNull();
  });

  it("saves local host config and restarts the managed stack from the local instance", async () => {
    const appWin = fakeAppWindow(LOCAL_URL);
    desktop.mainWindow = appWin.win;
    desktop.currentSetup = { mode: "new", serverUrl: LOCAL_URL };
    desktop.currentTargetUrl = LOCAL_URL;
    stackState = { ...stackState, phase: "ready" };

    const result = await mocks.invoke.get("desktop.server.saveLocalConfig")?.(appWin.event, {
      imageRepo: "ghcr.io/example-org/rakazo",
      imageTag: "edge",
      allowLanAccess: true,
      publicOrigin: "https://pc.example.ts.net",
      webhookPublicUrl: "",
      objectStorageBucket: "",
      objectStorageEndpoint: "",
      objectStorageRegion: "",
      workerConcurrency: "2",
      dbPoolMax: "12",
    });

    expect(result).toMatchObject({
      ok: true,
      state: {
        kind: "local",
        localConfig: {
          imageRepo: "ghcr.io/example-org/rakazo",
          imageTag: "edge",
          allowLanAccess: true,
          publicOrigin: "https://pc.example.ts.net",
          workerConcurrency: "2",
          dbPoolMax: "12",
        },
      },
    });
    expect(startStack).toHaveBeenCalledOnce();
    const env = await readFile(path.join(stackDir, STACK_ENV_FILE), "utf8");
    expect(env).toContain("RAKAZO_IMAGE=ghcr.io/example-org/rakazo/app");
    expect(env).toContain("GRAPHILE_WORKER_CONCURRENCY=2");
  });
});
