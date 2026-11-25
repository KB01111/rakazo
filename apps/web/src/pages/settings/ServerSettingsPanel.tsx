import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type {
  DesktopLocalHostConfig,
  DesktopLocalStackPhase,
  DesktopLocalStackState,
  DesktopServerState,
} from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import { Button, Field, FieldLabel, Input, Label, Switch } from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronRight, FolderOpen, Terminal } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { SuccessPop } from "../../components/ai/primitives";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { desktopBridge } from "../../lib/platform/desktop";
import { useSave } from "../../lib/query/query";

const ACTIVE_PHASES = new Set<DesktopLocalStackPhase>([
  "checking-docker",
  "preparing",
  "pulling",
  "starting",
  "waiting-healthy",
]);

const PHASE_PROGRESS: Partial<Record<DesktopLocalStackPhase, number>> = {
  "checking-docker": 8,
  preparing: 16,
  pulling: 48,
  starting: 82,
  "waiting-healthy": 92,
  ready: 100,
};

function draftFromConfig(config: DesktopLocalHostConfig): DesktopLocalHostConfig {
  return {
    imageRepo: config.imageRepo,
    imageTag: config.imageTag,
    allowLanAccess: config.allowLanAccess,
    publicOrigin: config.publicOrigin,
    webhookPublicUrl: config.webhookPublicUrl,
    objectStorageBucket: config.objectStorageBucket,
    objectStorageEndpoint: config.objectStorageEndpoint,
    objectStorageRegion: config.objectStorageRegion,
    objectStorageAccessKeyId: "",
    objectStorageSecretAccessKey: "",
    objectStorageCredentialsSet: config.objectStorageCredentialsSet,
    workerConcurrency: config.workerConcurrency,
    dbPoolMax: config.dbPoolMax,
  };
}

export function ServerSettingsPanel() {
  const { t } = useLingui();
  const server = desktopBridge()?.server;
  const [state, setState] = useState<DesktopServerState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<DesktopLocalHostConfig | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [savedConfig, setSavedConfig] = useState(false);
  const loginSwitchId = useId();
  const lanSwitchId = useId();

  useEffect(() => {
    if (!server?.state) return;
    let alive = true;
    const read = () => {
      server
        .state?.()
        .then((next) => {
          if (!alive || !next) return;
          setLoadFailed(false);
          setState(next);
          if (next.localConfig) {
            setDraft((current) => current ?? draftFromConfig(next.localConfig!));
          }
        })
        .catch(() => {
          if (alive) setLoadFailed(true);
        });
    };
    read();
    const unsubscribe = server.onLocalStackChange?.((nextStack: DesktopLocalStackState) => {
      if (!alive) return;
      setState((current) => (current ? { ...current, localStack: nextStack } : current));
      if (nextStack.phase === "failed" && nextStack.output.length > 0) {
        setDetailsOpen(true);
      }
      if (
        nextStack.phase === "ready" ||
        nextStack.phase === "idle" ||
        nextStack.phase === "failed"
      ) {
        read();
      }
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [server]);

  const action = useSave({
    save: async (
      kind: "change" | "hostLocally" | "restartLocal" | "stopLocal" | "openStackFolder",
    ) => {
      if (!server) return;
      if (kind === "change") {
        await server.change();
        return;
      }
      if (kind === "openStackFolder") {
        await server.openStackFolder?.();
        return;
      }
      const next = await server[kind]?.();
      if (next) {
        setState(next);
        if (next.localConfig) {
          setDraft((current) => current ?? draftFromConfig(next.localConfig!));
        }
      }
    },
  });

  const loginToggle = useSave({
    save: async (enabled: boolean) => {
      const next = await server?.setStartOnLogin?.(enabled);
      if (next) setState(next);
    },
  });

  const configSave = useSave({
    save: async (nextDraft: DesktopLocalHostConfig) => {
      if (!server?.saveLocalConfig) throw new Error(t`Server settings are unavailable.`);
      const result = await server.saveLocalConfig(nextDraft);
      if (!result.ok) throw new Error(result.error ?? t`Could not save local server settings.`);
      if (result.state) {
        setState(result.state);
        if (result.state.localConfig) setDraft(draftFromConfig(result.state.localConfig));
      }
      setSavedConfig(true);
    },
  });

  // Matches setup.js: while waiting for a freshly launched local runtime (Kiri or Docker Desktop),
  // re-probe every 3 seconds until it answers or the user leaves the page.
  const waitingForRuntime =
    state?.kind === "local" &&
    state.localStack.phase === "docker-not-running" &&
    Boolean(server?.restartLocal) &&
    !action.pending &&
    !configSave.pending;
  useTimeout(
    () => {
      if (server?.restartLocal) {
        void bestEffort("recheck local container runtime", server.restartLocal());
      }
    },
    waitingForRuntime ? 3_000 : null,
    state?.localStack,
  );

  if (!server) return null;

  if (!server.state) {
    return (
      <SettingsGroup data-testid="desktop-server-settings">
        <SettingsRow
          label={<Trans>Server connection</Trans>}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={action.pending}
              onClick={() => action.run("change")}
            >
              <Trans>Change server</Trans>
            </Button>
          }
        />
      </SettingsGroup>
    );
  }

  if (!state) {
    return loadFailed ? (
      <p role="alert" className="text-body-sm text-destructive">
        <Trans>Could not load server status.</Trans>
      </p>
    ) : null;
  }

  const stack = state.localStack;
  const starting = ACTIVE_PHASES.has(stack.phase);
  const running = state.kind === "local" && (state.localStackRunning || stack.phase === "ready");
  const showStackStatus =
    state.kind === "local" && stack.phase !== "idle" && stack.phase !== "ready";
  const supportsNetworkAndImages = state.localHostSupportsNetworkAndImages !== false;

  const serverTitle =
    state.kind === "local"
      ? t`This computer`
      : state.kind === "cloud"
        ? t`Rakazo Cloud`
        : t`Custom server`;

  const stackPhaseLabel = () => {
    switch (stack.phase) {
      case "checking-docker":
      case "preparing":
        return t`Getting ready…`;
      case "pulling":
        return t`Downloading Rakazo…`;
      case "starting":
        return t`Starting Rakazo…`;
      case "waiting-healthy":
        return t`Almost ready…`;
      case "docker-missing":
      case "docker-not-running":
      case "failed":
        return stack.message ?? t`Local services could not start.`;
      case "ready":
        return t`Running`;
      default:
        return running ? t`Running` : t`Stopped`;
    }
  };

  const progress = PHASE_PROGRESS[stack.phase] ?? 0;

  return (
    <div className="space-y-6" data-testid="desktop-server-settings">
      <SettingsGroup>
        <SettingsRow
          label={
            <>
              <p className="break-words">{serverTitle}</p>
              <p className="mt-0.5 break-all text-body-sm text-muted-foreground">
                {supportsNetworkAndImages
                  ? state.localConfig?.publicOrigin || state.serverUrl
                  : state.serverUrl}
              </p>
            </>
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={action.pending}
              onClick={() => action.run("change")}
            >
              <Trans>Change</Trans>
            </Button>
          }
        />

        {state.kind !== "local" && server.hostLocally ? (
          <SettingsRow
            label={
              <>
                <p>
                  <Trans>This computer</Trans>
                </p>
                <p className="mt-0.5 text-body-sm text-muted-foreground">
                  <Trans>Run Postgres, API, worker, web and bot computers locally.</Trans>
                </p>
              </>
            }
            control={
              <Button
                size="sm"
                data-testid="host-locally-button"
                disabled={action.pending}
                onClick={() => action.run("hostLocally")}
              >
                <Trans>Host on this PC</Trans>
              </Button>
            }
          />
        ) : null}

        {state.kind === "local" ? (
          <SettingsRow
            label={
              <>
                <p>
                  <Trans>Local services</Trans>
                </p>
                <p className="mt-0.5 text-body-sm text-muted-foreground">{stackPhaseLabel()}</p>
              </>
            }
            control={
              starting ? (
                <Button variant="secondary" size="sm" disabled>
                  <Trans>Starting…</Trans>
                </Button>
              ) : running ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="local-stack-restart"
                    disabled={action.pending || configSave.pending}
                    onClick={() => action.run("restartLocal")}
                  >
                    <Trans>Restart</Trans>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="local-stack-stop"
                    disabled={action.pending || configSave.pending}
                    onClick={() => action.run("stopLocal")}
                  >
                    <Trans>Stop</Trans>
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  data-testid="local-stack-start"
                  disabled={action.pending || configSave.pending}
                  onClick={() => action.run("restartLocal")}
                >
                  <Trans>Start</Trans>
                </Button>
              )
            }
          />
        ) : null}

        {state.kind === "local" && state.startOnLoginSupported && server.setStartOnLogin ? (
          <SettingsRow
            label={
              <Label htmlFor={loginSwitchId} className="text-body font-normal text-foreground">
                <Trans>Start when you sign in</Trans>
              </Label>
            }
            control={
              <Switch
                id={loginSwitchId}
                data-testid="start-on-login-toggle"
                checked={state.startOnLogin}
                disabled={loginToggle.pending}
                onCheckedChange={(checked) => loginToggle.run(checked)}
              />
            }
          />
        ) : null}
      </SettingsGroup>

      {action.error || loginToggle.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {action.error?.message ?? loginToggle.error?.message ?? t`Action failed. Try again.`}
        </p>
      ) : null}

      {showStackStatus ? (
        <section
          data-testid="local-stack-progress"
          className="rounded-xl border border-border px-4 py-3"
        >
          <div className="flex items-center justify-between gap-3">
            <p
              role="status"
              className={
                stack.phase === "failed"
                  ? "text-body-sm text-destructive"
                  : "text-body-sm text-foreground"
              }
            >
              {stackPhaseLabel()}
            </p>
            {stack.output.length > 0 ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t`Technical details`}
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <Terminal />
              </Button>
            ) : null}
          </div>
          {starting ? (
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={t`Setup progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          ) : null}
          {detailsOpen && stack.output.length > 0 ? (
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-caption text-muted-foreground whitespace-pre-wrap break-words">
              {stack.output.join("\n")}
            </pre>
          ) : null}
        </section>
      ) : null}

      {state.kind === "local" && draft && server.saveLocalConfig ? (
        <Collapsible open={optionsOpen} onOpenChange={setOptionsOpen}>
          <CollapsibleTrigger
            data-testid="local-hosting-options-trigger"
            className="flex items-center gap-1.5 text-body-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={`size-4 transition-transform ${optionsOpen ? "rotate-90" : ""}`}
            />
            <Trans>Hosting options</Trans>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">
            <LocalHostConfigForm
              draft={draft}
              lanSwitchId={lanSwitchId}
              supportsNetworkAndImages={supportsNetworkAndImages}
              pending={configSave.pending || action.pending || starting}
              error={configSave.error?.message ?? null}
              saved={savedConfig}
              onChange={(patch) => {
                setSavedConfig(false);
                configSave.reset();
                setDraft((current) => (current ? { ...current, ...patch } : current));
              }}
              onSubmit={() => configSave.run(draft)}
              onOpenFolder={
                server.openStackFolder ? () => action.run("openStackFolder") : undefined
              }
            />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function LocalHostConfigForm({
  draft,
  lanSwitchId,
  supportsNetworkAndImages,
  pending,
  error,
  saved,
  onChange,
  onSubmit,
  onOpenFolder,
}: {
  draft: DesktopLocalHostConfig;
  lanSwitchId: string;
  supportsNetworkAndImages: boolean;
  pending: boolean;
  error: string | null;
  saved: boolean;
  onChange: (patch: Partial<DesktopLocalHostConfig>) => void;
  onSubmit: () => void;
  onOpenFolder?: () => void;
}) {
  const { t } = useLingui();
  const baseId = useId();
  return (
    <form
      data-testid="local-host-config-form"
      className="space-y-4 rounded-xl border border-border px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset className="grid gap-3" disabled={pending}>
        {supportsNetworkAndImages ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${baseId}-repo`}>
                  <Trans>Image repository</Trans>
                </FieldLabel>
                <Input
                  id={`${baseId}-repo`}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="ghcr.io/owner/rakazo"
                  value={draft.imageRepo}
                  onChange={(event) => onChange({ imageRepo: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${baseId}-tag`}>
                  <Trans>Image tag</Trans>
                </FieldLabel>
                <Input
                  id={`${baseId}-tag`}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="edge"
                  value={draft.imageTag}
                  onChange={(event) => onChange({ imageTag: event.target.value })}
                />
              </Field>
            </div>

            <div className="flex items-center justify-between gap-4 py-1">
              <Label htmlFor={lanSwitchId} className="text-body font-normal text-foreground">
                <Trans>Allow local network access</Trans>
              </Label>
              <Switch
                id={lanSwitchId}
                data-testid="allow-lan-access-toggle"
                checked={draft.allowLanAccess}
                onCheckedChange={(allowLanAccess) => onChange({ allowLanAccess })}
              />
            </div>

            <Field>
              <FieldLabel htmlFor={`${baseId}-public`}>
                <Trans>Public or tailnet URL</Trans>
              </FieldLabel>
              <Input
                id={`${baseId}-public`}
                type="url"
                spellCheck={false}
                autoComplete="off"
                placeholder="https://machine.example.ts.net"
                value={draft.publicOrigin}
                onChange={(event) => onChange({ publicOrigin: event.target.value })}
              />
            </Field>
          </>
        ) : null}

        <Field>
          <FieldLabel htmlFor={`${baseId}-webhook`}>
            <Trans>Webhook ingress URL</Trans>
          </FieldLabel>
          <Input
            id={`${baseId}-webhook`}
            type="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://hooks.example.com"
            value={draft.webhookPublicUrl}
            onChange={(event) => onChange({ webhookPublicUrl: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${baseId}-bucket`}>
              <Trans>S3 object storage bucket</Trans>
            </FieldLabel>
            <Input
              id={`${baseId}-bucket`}
              spellCheck={false}
              autoComplete="off"
              value={draft.objectStorageBucket}
              onChange={(event) => onChange({ objectStorageBucket: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${baseId}-region`}>
              <Trans>Region</Trans>
            </FieldLabel>
            <Input
              id={`${baseId}-region`}
              spellCheck={false}
              autoComplete="off"
              placeholder="auto"
              value={draft.objectStorageRegion}
              onChange={(event) => onChange({ objectStorageRegion: event.target.value })}
            />
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor={`${baseId}-endpoint`}>
            <Trans>S3 endpoint URL</Trans>
          </FieldLabel>
          <Input
            id={`${baseId}-endpoint`}
            type="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://storage.example.com"
            value={draft.objectStorageEndpoint}
            onChange={(event) => onChange({ objectStorageEndpoint: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${baseId}-key-id`}>
              <Trans>Access key ID</Trans>
            </FieldLabel>
            <Input
              id={`${baseId}-key-id`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={draft.objectStorageCredentialsSet ? t`Saved` : undefined}
              value={draft.objectStorageAccessKeyId ?? ""}
              onChange={(event) => onChange({ objectStorageAccessKeyId: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${baseId}-secret-key`}>
              <Trans>Secret access key</Trans>
            </FieldLabel>
            <Input
              id={`${baseId}-secret-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={draft.objectStorageCredentialsSet ? t`Saved` : undefined}
              value={draft.objectStorageSecretAccessKey ?? ""}
              onChange={(event) => onChange({ objectStorageSecretAccessKey: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${baseId}-worker`}>
              <Trans>Worker concurrency</Trans>
            </FieldLabel>
            <Input
              id={`${baseId}-worker`}
              inputMode="numeric"
              placeholder="2"
              value={draft.workerConcurrency}
              onChange={(event) => onChange({ workerConcurrency: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${baseId}-pool`}>
              <Trans>Database pool size</Trans>
            </FieldLabel>
            <Input
              id={`${baseId}-pool`}
              inputMode="numeric"
              placeholder="12"
              value={draft.dbPoolMax}
              onChange={(event) => onChange({ dbPoolMax: event.target.value })}
            />
          </Field>
        </div>
      </fieldset>

      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          <Trans>Save and apply</Trans>
        </Button>
        {onOpenFolder ? (
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onOpenFolder}>
            <FolderOpen />
            <Trans>Open stack folder</Trans>
          </Button>
        ) : null}
        {saved ? <SuccessPop label={t`Saved`} /> : null}
      </div>
    </form>
  );
}
