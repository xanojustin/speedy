// The Hosts tab of Settings (R1, R3, R5): add a host from ~/.ssh/config, see each host's
// connection and setup, reconnect or remove it, and give a host that can't reach its login
// Keychain a `claude setup-token` token.
import { useEffect, useState } from "react";
import { getSetupState, hostAliases, hostReconnect, setClaudeToken } from "../ipc/commands";
import { LOCAL_HOST, type HostInfo, type HostSetupState } from "../ipc/types";
import { hostLabel, hostStateLabel, useAppStore } from "../store/appStore";
import "./hosts.css";

export function HostsSettings() {
  const hosts = useAppStore((s) => s.hosts);
  const [aliases, setAliases] = useState<string[]>([]);
  const [alias, setAlias] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    void hostAliases()
      .then((list) => {
        setAliases(list ?? []);
        setAlias((list ?? [])[0] ?? "");
      })
      .catch(() => setAliases([]));
  }, [hosts.length]);

  const add = async () => {
    if (!alias) return;
    setAdding(alias);
    setAddError(null);
    try {
      await useAppStore.getState().addHost(alias);
    } catch (err) {
      setAddError(String(err));
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="settings-section">
      <ul className="hosts-list" aria-label="Hosts">
        {hosts.map((h) => (
          <HostItem key={h.key} host={h} />
        ))}
      </ul>
      <div className="hosts-add">
        <select className="vscode-input settings-select" aria-label="SSH host" value={alias} disabled={!!adding || aliases.length === 0} onChange={(e) => setAlias(e.target.value)}>
          {aliases.length === 0 && <option value="">No other hosts in ~/.ssh/config</option>}
          {aliases.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button type="button" className="primary-button" disabled={!alias || !!adding} onClick={() => void add()}>
          Add Host
        </button>
      </div>
      {adding && (
        <p className="hosts-item-detail" role="status">
          Connecting to {adding}… The first time, Speedy installs its agent there.
        </p>
      )}
      {addError && (
        <p className="hosts-item-detail" role="alert">
          {addError}
        </p>
      )}
    </div>
  );
}

function HostItem({ host }: { host: HostInfo }) {
  const [setup, setSetup] = useState<HostSetupState | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = host.state.state === "connected";

  useEffect(() => {
    if (!connected) return setSetup(null);
    void getSetupState(host.key)
      .then(setSetup)
      .catch(() => setSetup(null));
  }, [connected, host.key]);

  // Background-domain agents can't read the login Keychain; a token works instead (KTD8).
  const needsToken = setup?.status === "not_logged_in" && setup.launchDomain !== "aqua";
  const detail =
    host.state.state === "reconnecting"
      ? host.state.error
      : host.state.state === "connected"
        ? `Agent ${host.state.agent_version}${setup && setup.status !== "ready" ? ` · ${setup.message ?? setup.status}` : ""}`
        : null;

  return (
    <li className="hosts-item">
      <div className="hosts-item-head">
        <span className="hosts-item-name">{hostLabel(host.key)}</span>
        <span className={`host-header-state${connected ? " connected" : ""}`}>{hostStateLabel(host)}</span>
        {host.key !== LOCAL_HOST && (
          <>
            <button type="button" className="secondary-button" onClick={() => void hostReconnect(host.key).catch((err) => console.warn("reconnect failed", err))}>
              Reconnect
            </button>
            <button type="button" className="secondary-button" onClick={() => void useAppStore.getState().removeHost(host.key)}>
              Remove
            </button>
          </>
        )}
      </div>
      {detail && <div className="hosts-item-detail">{detail}</div>}
      {needsToken && (
        <form
          className="hosts-token"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void setClaudeToken(host.key, token)
              .then((next) => {
                setSetup(next);
                setToken("");
              })
              .catch((err) => console.warn("saving the token failed", err))
              .finally(() => setBusy(false));
          }}
        >
          <input
            className="vscode-input"
            type="password"
            aria-label={`Claude token for ${hostLabel(host.key)}`}
            placeholder="Paste the token from `claude setup-token` on this host"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit" className="primary-button" disabled={!token || busy}>
            Save Token
          </button>
        </form>
      )}
    </li>
  );
}
