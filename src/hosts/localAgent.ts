// Stopping This Mac's agent and quitting the app (R17, KTD11). Threads belong to the agent, so
// quitting leaves them running; stopping the agent is the way to end them, and asks first.
import { ask } from "@tauri-apps/plugin-dialog";
import { localAgentStop, quitConfirmed } from "../ipc/commands";
import { LOCAL_HOST } from "../ipc/types";
import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** This Mac's threads that are working right now. */
function localWorking(): number {
  const threads = useThreadStore.getState().threads;
  return useAppStore
    .getState()
    .projects.filter((p) => p.hostKey === LOCAL_HOST)
    .flatMap((p) => p.threads)
    .filter((t) => threads[t.id]?.status === "working").length;
}

/** Stops This Mac's agent, asking first when threads are working. */
export async function stopLocalAgent(): Promise<void> {
  const working = localWorking();
  if (working > 0) {
    const ok = await ask(`${plural(working, "thread")} on This Mac ${working === 1 ? "is" : "are"} still working. Stopping the agent stops ${working === 1 ? "it" : "them"} and every terminal.`, {
      title: "Stop This Mac's agent?",
      kind: "warning",
      okLabel: "Stop Agent",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
  }
  await localAgentStop().catch((err) => console.warn("stopping the agent failed", err));
}

/** Called when the user quits while This Mac's threads work: they keep running, and that's said. */
export async function confirmQuit(working: number): Promise<void> {
  const ok = await ask(`${plural(working, "thread")} on This Mac ${working === 1 ? "keeps" : "keep"} running after Speedy quits. Reopen Speedy to see ${working === 1 ? "it" : "them"} finish.`, {
    title: "Quit Speedy?",
    kind: "info",
    okLabel: "Quit",
    cancelLabel: "Cancel",
  });
  if (ok) await quitConfirmed();
}
