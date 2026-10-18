import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => undefined,
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";
import { ActivityPanel } from "./ActivityPanel";
import { ChatHeader } from "./ChatHeader";

let threadId = "";
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  useThreadStore.getState().dispatch(threadId, {
    kind: "message",
    seq: 1,
    raw: { type: "assistant", message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null },
  });

beforeEach(() => {
  useThreadStore.setState({ threads: {} });
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false, activityPanelVisible: false });
  threadId = useAppStore.getState().addProject("/work/proj");
});
afterEach(cleanup);

describe("ActivityPanel", () => {
  it("stays hidden until toggled on from the header, and hides again when toggled off", async () => {
    toolUse("t1", "TodoWrite", { todos: [{ content: "Write the panel", status: "in_progress", activeForm: "Writing the panel" }, { content: "Test it", status: "pending" }] });
    toolUse("a1", "Agent", { description: "Scan the repo", prompt: "p", subagent_type: "Explore" });
    render(
      <>
        <ChatHeader threadId={threadId} />
        <ActivityPanel threadId={threadId} />
      </>,
    );
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Activity" })).toBeNull();

    const toggle = screen.getByRole("button", { name: "Activity" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const panel = screen.getByRole("region", { name: "Activity" });
    expect(panel).toHaveTextContent("0/2 tasks");
    expect(panel).toHaveTextContent("1 running");
    expect(panel).toHaveTextContent("Write the panel");
    expect(panel).toHaveTextContent("Scan the repo");

    fireEvent.click(screen.getByRole("button", { name: /0\/2 tasks/ }));
    expect(panel).toHaveTextContent("Writing the panel");
    expect(panel).not.toHaveTextContent("Test it");

    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "Activity" })).toBeNull();
  });

  it("shrinks to one line when there is nothing to track", () => {
    useAppStore.setState({ activityPanelVisible: true });
    render(<ActivityPanel threadId={threadId} />);
    const panel = screen.getByRole("region", { name: "Activity" });
    expect(panel).toHaveTextContent("Nothing running");
    expect(screen.queryByRole("button", { name: /Activity/ })).toBeNull();
  });
});
