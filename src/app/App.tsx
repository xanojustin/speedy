// Loads app state, gates on the CLI setup state (R13), then shows the Layout.
import { useEffect, useState } from "react";
import { AskpassDialog } from "../hosts/AskpassDialog";
import { confirmQuit } from "../hosts/localAgent";
import { getSetupState, onQuitRequested, recheckSetup } from "../ipc/commands";
import type { SetupState } from "../ipc/types";
import { LOCAL_HOST } from "../ipc/types";
import { useAppStore, waitForHost } from "../store/appStore";
import { useAppTheme } from "../theme/appTheme";
import { Layout } from "./Layout";
import { SetupScreen } from "./SetupScreen";
import "./app.css";

/** How long launch waits for This Mac's agent (a first run installs it). */
const AGENT_START_MS = 30_000;

export function App() {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [mismatchDismissed, setMismatchDismissed] = useState(false);
  const notice = useAppStore((s) => s.notice);
  const dismissNotice = useAppStore((s) => s.dismissNotice);
  useAppTheme();

  // Quitting while This Mac's threads work says they keep running (R17).
  useEffect(() => {
    const unlisten = onQuitRequested((working) => void confirmQuit(working));
    return () => void unlisten.then((fn) => fn());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: SetupState;
      try {
        await useAppStore.getState().load();
        // On first run This Mac's agent is still being installed.
        await waitForHost(LOCAL_HOST, AGENT_START_MS).catch((err: unknown) => {
          throw new Error(`This Mac's agent didn't start: ${err instanceof Error ? err.message : String(err)}`);
        });
        next = await getSetupState();
        // A saved override path only takes effect when handed to the resolver.
        const override = useAppStore.getState().claudePathOverride;
        if (next.status !== "ready" && override) next = await recheckSetup(override);
      } catch (err) {
        next = startupError(err);
      }
      if (!cancelled) setSetup(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!setup || setup.status === "resolving") {
    return (
      <div className="app-loading" role="status">
        <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden />
        Starting Speedy…
      </div>
    );
  }

  if (setup.status !== "ready") return <SetupScreen setup={setup} onChange={setSetup} />;

  return (
    <div className="app">
      <AskpassDialog />
      {notice && <Banner icon="info" text={notice} onDismiss={dismissNotice} />}
      {setup.versionMismatch && !mismatchDismissed && (
        <Banner
          icon="warning"
          text={`Installed CLI ${setup.claudeVersion ?? "unknown"} differs from tested ${setup.fixtureVersion}; run the protocol drift test.`}
          onDismiss={() => setMismatchDismissed(true)}
        />
      )}
      <Layout />
    </div>
  );
}

function Banner({ icon, text, onDismiss }: { icon: string; text: string; onDismiss: () => void }) {
  return (
    <div className="banner" role="alert">
      <span className={`codicon codicon-${icon} banner-icon`} aria-hidden />
      <span className="banner-text">{text}</span>
      <button type="button" className="icon-button banner-dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <span className="codicon codicon-close" aria-hidden />
      </button>
    </div>
  );
}

function startupError(err: unknown): SetupState {
  return {
    status: "error",
    claudePath: null,
    claudeVersion: null,
    fixtureVersion: "",
    versionMismatch: false,
    searchedPaths: [],
    envDegraded: false,
    message: `Speedy couldn't start: ${err instanceof Error ? err.message : String(err)}`,
  };
}
