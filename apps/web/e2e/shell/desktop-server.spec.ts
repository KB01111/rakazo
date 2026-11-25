import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

test("desktop server settings can switch to local hosting and edit hosting options", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    let state: {
      kind: "cloud" | "local" | "existing";
      serverUrl: string;
      localWebUrl: string;
      localStack: {
        phase: string;
        message: string | null;
        output: string[];
        layerBytes: Record<string, number>;
        imageTag: string;
      };
      localStackRunning: boolean;
      startOnLogin: boolean;
      startOnLoginSupported: boolean;
      localConfig: {
        imageRepo: string;
        imageTag: string;
        allowLanAccess: boolean;
        publicOrigin: string;
        webhookPublicUrl: string;
        objectStorageBucket: string;
        objectStorageEndpoint: string;
        objectStorageRegion: string;
        objectStorageCredentialsSet?: boolean;
        workerConcurrency: string;
        dbPoolMax: string;
      } | null;
    } = {
      kind: "cloud",
      serverUrl: "https://rakazo.com",
      localWebUrl: "",
      localStack: { phase: "idle", message: null, output: [], layerBytes: {}, imageTag: "" },
      localStackRunning: false,
      startOnLogin: false,
      startOnLoginSupported: false,
      localConfig: null,
    };

    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        server: {
          change: async () => {},
          state: async () => state,
          hostLocally: async () => {
            state = {
              kind: "local",
              serverUrl: "http://127.0.0.1:45173",
              localWebUrl: "http://127.0.0.1:45173",
              localStack: {
                phase: "ready",
                message: null,
                output: [],
                layerBytes: {},
                imageTag: "edge",
              },
              localStackRunning: true,
              startOnLogin: false,
              startOnLoginSupported: true,
              localConfig: {
                imageRepo: "ghcr.io/elie222/rakazo",
                imageTag: "edge",
                allowLanAccess: false,
                publicOrigin: "",
                webhookPublicUrl: "",
                objectStorageBucket: "",
                objectStorageEndpoint: "",
                objectStorageRegion: "",
                objectStorageCredentialsSet: false,
                workerConcurrency: "",
                dbPoolMax: "",
              },
            };
            return state;
          },
          restartLocal: async () => state,
          stopLocal: async () => {
            state = {
              ...state,
              localStack: { ...state.localStack, phase: "idle" },
              localStackRunning: false,
            };
            return state;
          },
          saveLocalConfig: async (nextConfig: NonNullable<typeof state.localConfig>) => {
            state = {
              ...state,
              localConfig: {
                ...nextConfig,
                objectStorageCredentialsSet: Boolean(nextConfig.objectStorageCredentialsSet),
              },
            };
            return { ok: true, state };
          },
          setStartOnLogin: async (enabled: boolean) => {
            state = { ...state, startOnLogin: enabled };
            return state;
          },
          openStackFolder: async () => {},
          onLocalStackChange: () => () => {},
        },
      },
    });
  });

  const stamp = Date.now();
  await signup(page, `desktop-server-${stamp}@rakazo.test`, "password12", "Server Tester");
  await completeOnboarding(page);
  await openUserSettings(page, "server");

  const panel = page.getByTestId("desktop-server-settings");
  await expect(panel.getByText("Rakazo Cloud")).toBeVisible();
  await expect(panel.getByTestId("host-locally-button")).toBeVisible();
  await captureScreenshot(page, testInfo, "desktop-server-cloud");

  await panel.getByTestId("host-locally-button").click();
  await expect(panel.getByText("This computer")).toBeVisible();
  await expect(panel.getByText("Running")).toBeVisible();

  await panel.getByTestId("local-hosting-options-trigger").click();
  await expect(panel.getByTestId("local-host-config-form")).toBeVisible();
  await panel.getByLabel("Public or tailnet URL").fill("https://pc.example.ts.net");
  await panel.getByRole("button", { name: "Save and apply" }).click();
  await expect(panel.getByText("https://pc.example.ts.net")).toBeVisible();
  await captureScreenshot(page, testInfo, "desktop-server-local-options");
});
