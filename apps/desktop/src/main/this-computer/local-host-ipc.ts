import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  DesktopLocalStackState,
  DesktopServerKind,
  DesktopServerState,
} from "@rakazo/contracts";
import { isLoopbackHost } from "@rakazo/contracts/network-host";
import { app, dialog, shell } from "electron";
import { appWindowTargets, desktop } from "../desktop-state.js";
import { t } from "../i18n.js";
import type { IpcCaller } from "../ipc/ipc.js";
import { handleIpc, sentFrom } from "../ipc/ipc.js";
import { RAKAZO_CLOUD_URL } from "../setup/setup-config.js";
import { showSetupWindow } from "../setup/setup-window.js";
import { isManagedComputerRequest } from "./computer-access.js";
import {
  parseLocalHostConfigInput,
  readLocalHostConfig,
  writeLocalHostConfig,
} from "./local-host-config.js";
import { ensureStackEnv, initialStackState, STACK_ENV_TEMPLATE } from "./local-stack.js";

function supportsLoginItem(platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

function activeServerUrl(): string {
  const windowUrl =
    desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed()
      ? appWindowTargets.get(desktop.mainWindow)
      : undefined;
  return (
    windowUrl ?? desktop.currentTargetUrl ?? desktop.currentSetup?.serverUrl ?? RAKAZO_CLOUD_URL
  );
}

function isManagedMainWindow(): boolean {
  return (
    desktop.mainWindow !== null &&
    !desktop.mainWindow.isDestroyed() &&
    desktop.currentSetup?.mode === "new" &&
    appWindowTargets.get(desktop.mainWindow) === desktop.localStack.webUrl()
  );
}

export function classifyServerKind(input: {
  managedLocal: boolean;
  serverUrl: string;
}): DesktopServerKind {
  if (input.managedLocal) return "local";
  return input.serverUrl === RAKAZO_CLOUD_URL ? "cloud" : "existing";
}

function isLoopbackOrigin(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function confirmSwitchToLocal(serverUrl: string): Promise<boolean> {
  const host = (() => {
    try {
      return new URL(serverUrl).host;
    } catch {
      return serverUrl;
    }
  })();
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: t("Host Rakazo on this computer?"),
    message: t("Host Rakazo on this computer?"),
    detail: t(
      "Rakazo will start its local services on this computer and switch away from {host}.",
      { host },
    ),
    buttons: [t("Cancel"), t("Start local server")],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  };
  const win =
    desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed() ? desktop.mainWindow : null;
  const result = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  return result.response === 1;
}

export interface ServerIpcDeps {
  userStackDir: string;
  resourceDir: string;
  randomHex: (bytes: number) => string;
  settleLocalStack: () => Promise<void>;
  installApplicationMenu: () => void;
}

export function broadcastLocalStackState(state: DesktopLocalStackState): void {
  if (desktop.setupWindow !== null && !desktop.setupWindow.isDestroyed())
    desktop.setupWindow.webContents.send("desktop.setup.stack.changed", state);
  if (isManagedMainWindow())
    desktop.mainWindow!.webContents.send("desktop.server.localStack.changed", state);
}

/**
 * Handles `desktop.server.*` IPC from the app window.
 * Read-only connection status is visible to any server; local Docker status/logs and mutating
 * local-host actions are restricted to the authenticated app-managed local instance, and switching
 * from a remote custom server asks for native confirmation before starting Docker.
 */
export function registerServerIpc({
  userStackDir,
  resourceDir,
  randomHex,
  settleLocalStack,
  installApplicationMenu,
}: ServerIpcDeps) {
  const readServerState = async (event: IpcCaller): Promise<DesktopServerState> => {
    const managedLocal = isManagedComputerRequest(event);
    const serverUrl = activeServerUrl();
    const kind = classifyServerKind({ managedLocal, serverUrl });
    const loginSupported = supportsLoginItem();
    const startOnLogin =
      managedLocal && loginSupported ? app.getLoginItemSettings().openAtLogin : false;
    const localConfig = managedLocal ? await readLocalHostConfig(userStackDir) : null;
    return {
      kind,
      serverUrl,
      localWebUrl: managedLocal ? desktop.localStack.webUrl() : "",
      localStack: managedLocal ? desktop.localStack.state() : initialStackState(""),
      localStackRunning: managedLocal ? desktop.localStack.managedStackRunning() : false,
      startOnLogin,
      startOnLoginSupported: managedLocal && loginSupported,
      localConfig,
    };
  };

  handleIpc("desktop.server.change", () => {
    desktop.autoStartLocalSetup = false;
    showSetupWindow();
  });

  handleIpc("desktop.server.state", (event) => readServerState(event));

  handleIpc("desktop.server.hostLocally", async (event) => {
    const managedLocal = isManagedComputerRequest(event);
    if (managedLocal) {
      await settleLocalStack();
      if (!isManagedComputerRequest(event)) return null;
      if (!(await desktop.localStack.matchesDesiredStack())) {
        if (!isManagedComputerRequest(event)) return null;
        void desktop.localStack.start();
      }
      return readServerState(event);
    }
    const currentUrl = activeServerUrl();
    const kind = classifyServerKind({ managedLocal: false, serverUrl: currentUrl });
    if (kind === "existing" && !isLoopbackOrigin(currentUrl)) {
      const confirmed = await confirmSwitchToLocal(currentUrl);
      if (!sentFrom("app", event)) return null;
      if (!confirmed) return readServerState(event);
    }
    await settleLocalStack();
    if (!sentFrom("app", event)) return null;
    desktop.autoStartLocalSetup = true;
    void desktop.localStack.start();
    const existingSetup =
      desktop.setupWindow !== null && !desktop.setupWindow.isDestroyed()
        ? desktop.setupWindow
        : null;
    const win = showSetupWindow();
    if (existingSetup === win) win.reload();
    return readServerState(event);
  });

  handleIpc("desktop.server.restartLocal", async (event) => {
    if (!isManagedComputerRequest(event)) return null;
    await settleLocalStack();
    if (!isManagedComputerRequest(event)) return null;
    void desktop.localStack.start();
    return readServerState(event);
  });

  handleIpc("desktop.server.stopLocal", async (event) => {
    if (!isManagedComputerRequest(event)) return null;
    desktop.hostComputer?.activate(false);
    await desktop.localStack.stop();
    installApplicationMenu();
    return isManagedComputerRequest(event) ? readServerState(event) : null;
  });

  handleIpc("desktop.server.saveLocalConfig", async (event, payload) => {
    if (!isManagedComputerRequest(event)) {
      return {
        ok: false,
        error: "Local host settings require an app-managed local instance.",
      };
    }
    const parsed = parseLocalHostConfigInput(payload);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    try {
      await mkdir(userStackDir, { recursive: true, mode: 0o700 });
      const template = await readFile(path.join(resourceDir, STACK_ENV_TEMPLATE), "utf8");
      await ensureStackEnv(userStackDir, template, randomHex);
      if (!isManagedComputerRequest(event)) {
        return {
          ok: false,
          error: "Local host settings require an app-managed local instance.",
        };
      }
      await writeLocalHostConfig(userStackDir, parsed.value);
      await settleLocalStack();
      if (!isManagedComputerRequest(event)) {
        return {
          ok: false,
          error: "Local host settings require an app-managed local instance.",
        };
      }
      void desktop.localStack.start();
      return { ok: true, state: await readServerState(event) };
    } catch {
      return { ok: false, error: "Could not save local server settings. Try again." };
    }
  });

  handleIpc("desktop.server.setStartOnLogin", async (event, enabled) => {
    if (!isManagedComputerRequest(event) || typeof enabled !== "boolean") return null;
    if (supportsLoginItem()) {
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
    return readServerState(event);
  });

  handleIpc("desktop.server.openStackFolder", async (event) => {
    if (!isManagedComputerRequest(event)) return;
    await mkdir(userStackDir, { recursive: true, mode: 0o700 });
    await shell.openPath(userStackDir);
  });
}
