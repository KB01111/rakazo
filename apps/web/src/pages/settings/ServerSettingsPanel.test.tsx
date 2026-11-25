// @vitest-environment jsdom

import type { DesktopLocalStackState, DesktopServerState, RakazoDesktop } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & React.ComponentProps<"button">) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
}));

vi.mock("@rakazo/ui-web/components/ui/collapsible", () => ({
  Collapsible: ({ open, children }: { open?: boolean; children?: ReactNode }) => (
    <div data-open={String(Boolean(open))}>{children}</div>
  ),
  CollapsibleTrigger: ({
    children,
    ...props
  }: React.ComponentProps<"button"> & { children?: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../components/ai/primitives", () => ({
  SuccessPop: ({ label }: { label: string }) => <span>{label}</span>,
}));

import { ServerSettingsPanel } from "./ServerSettingsPanel";

function stack(phase: DesktopLocalStackState["phase"]): DesktopLocalStackState {
  return { phase, message: null, output: [], layerBytes: {}, imageTag: "edge" };
}

afterEach(() => {
  delete window.rakazoDesktop;
  document.body.innerHTML = "";
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ServerSettingsPanel />);
  });
  return {
    container,
    unmount: () =>
      act(async () => {
        root.unmount();
        container.remove();
      }),
  };
}

it("starts local hosting in one click from Rakazo Cloud", async () => {
  const hostLocally = vi.fn(async () => null);
  const state: DesktopServerState = {
    kind: "cloud",
    serverUrl: "https://app.rakazo.com",
    localWebUrl: "http://127.0.0.1:45173",
    localStack: stack("idle"),
    localStackRunning: false,
    startOnLogin: false,
    startOnLoginSupported: false,
    localConfig: null,
  };
  window.rakazoDesktop = {
    platform: "win32",
    server: {
      change: vi.fn(async () => undefined),
      state: vi.fn(async () => state),
      hostLocally,
      onLocalStackChange: () => () => undefined,
    },
  } as unknown as RakazoDesktop;

  const { container, unmount } = await mount();
  const button = container.querySelector<HTMLButtonElement>('[data-testid="host-locally-button"]');
  expect(button?.textContent).toContain("Host on this PC");
  await act(async () => {
    button?.click();
  });
  expect(hostLocally).toHaveBeenCalledOnce();
  await unmount();
});

it("manages local services, login launch, live progress and hosting options when running locally", async () => {
  let pushStack: ((next: DesktopLocalStackState) => void) | undefined;
  const localState: DesktopServerState = {
    kind: "local",
    serverUrl: "http://127.0.0.1:45173",
    localWebUrl: "http://127.0.0.1:45173",
    localStack: stack("ready"),
    localStackRunning: true,
    startOnLogin: false,
    startOnLoginSupported: true,
    localConfig: {
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
    },
  };
  const setStartOnLogin = vi.fn(async (enabled: boolean) => ({
    ...localState,
    startOnLogin: enabled,
  }));
  const saveLocalConfig = vi.fn(async (config) => ({
    ok: true,
    state: { ...localState, localConfig: config },
  }));
  const restartLocal = vi.fn(async () => localState);
  window.rakazoDesktop = {
    platform: "win32",
    server: {
      change: vi.fn(async () => undefined),
      state: vi.fn(async () => localState),
      restartLocal,
      stopLocal: vi.fn(async () => ({
        ...localState,
        localStack: stack("idle"),
        localStackRunning: false,
      })),
      saveLocalConfig,
      setStartOnLogin,
      openStackFolder: vi.fn(async () => undefined),
      onLocalStackChange: (listener: (next: DesktopLocalStackState) => void) => {
        pushStack = listener;
        return () => undefined;
      },
    },
  } as unknown as RakazoDesktop;

  const { container, unmount } = await mount();
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="start-on-login-toggle"]')?.click();
  });
  expect(setStartOnLogin).toHaveBeenCalledWith(true);

  const form = container.querySelector<HTMLFormElement>('[data-testid="local-host-config-form"]');
  expect(form).not.toBeNull();
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(saveLocalConfig).toHaveBeenCalledOnce();

  await act(async () => {
    pushStack?.({ ...stack("pulling"), output: ["Pulling api"] });
  });
  expect(container.querySelector('[data-testid="local-stack-progress"]')).not.toBeNull();
  await unmount();
});

it("hides container/network options when unsupported and disables save while restart is pending", async () => {
  const pendingRestart = deferred<DesktopServerState | null>();
  const localState: DesktopServerState = {
    kind: "local",
    serverUrl: "http://127.0.0.1:45173",
    localWebUrl: "http://127.0.0.1:45173",
    localStack: stack("ready"),
    localStackRunning: true,
    startOnLogin: false,
    startOnLoginSupported: true,
    localHostSupportsNetworkAndImages: false,
    localConfig: {
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
    },
  };
  window.rakazoDesktop = {
    platform: "darwin",
    server: {
      change: vi.fn(async () => undefined),
      state: vi.fn(async () => localState),
      restartLocal: vi.fn(() => pendingRestart.promise),
      stopLocal: vi.fn(async () => localState),
      saveLocalConfig: vi.fn(async () => ({ ok: true, state: localState })),
      onLocalStackChange: () => () => undefined,
    },
  } as unknown as RakazoDesktop;

  const { container, unmount } = await mount();
  expect(container.querySelector('[data-testid="allow-lan-access-toggle"]')).toBeNull();

  const restartButton = container.querySelector<HTMLButtonElement>(
    '[data-testid="local-stack-restart"]',
  );
  const saveButton = container.querySelector<HTMLButtonElement>(
    '[data-testid="local-host-config-form"] button[type="submit"]',
  );
  expect(saveButton?.disabled).toBe(false);
  await act(async () => {
    restartButton?.click();
  });
  expect(saveButton?.disabled).toBe(true);
  await act(async () => {
    pendingRestart.resolve(localState);
  });
  expect(saveButton?.disabled).toBe(false);
  await unmount();
});
