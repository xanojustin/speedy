import { beforeEach, describe, expect, it } from "vitest";
import { terminalLabel, terminalsOf, useTerminalTabs } from "./tabs";

const tabs = () => useTerminalTabs.getState();
const of = (threadId: string) => terminalsOf(tabs().byThread, threadId);
const initial = useTerminalTabs.getState();

beforeEach(() => useTerminalTabs.setState(initial, true));

describe("terminal tabs", () => {
  it("starts every thread with one terminal named after the thread, and returns a stable default", () => {
    expect(of("t")).toEqual({ ids: ["t"], active: "t", next: 2 });
    expect(of("t")).toBe(of("t"));
    expect(terminalLabel("t", "t")).toBe("Terminal 1");
  });

  it("adds terminals as active and keeps numbering when one closes", () => {
    expect(tabs().add("t")).toBe("t:2");
    expect(tabs().add("t")).toBe("t:3");
    expect(of("t")).toMatchObject({ ids: ["t", "t:2", "t:3"], active: "t:3" });
    expect(tabs().remove("t", "t:2")).toBe(false);
    expect(of("t").ids).toEqual(["t", "t:3"]);
    expect(terminalLabel("t", "t:3")).toBe("Terminal 3");
  });

  it("activates the neighbour when the active tab closes", () => {
    tabs().add("t");
    tabs().add("t");
    tabs().setActive("t", "t:2");
    tabs().remove("t", "t:2");
    expect(of("t").active).toBe("t:3");
    tabs().remove("t", "t:3");
    expect(of("t").active).toBe("t");
  });

  it("replaces the last terminal with a fresh id", () => {
    tabs().setTitle("t", "vim");
    expect(tabs().remove("t", "t")).toBe(true);
    expect(of("t")).toEqual({ ids: ["t:2"], active: "t:2", next: 3 });
    expect(tabs().titles).toEqual({});
  });

  it("forgets a thread's tabs and titles", () => {
    tabs().add("t");
    tabs().setTitle("t:2", "npm");
    expect(tabs().forgetThread("t")).toEqual(["t", "t:2"]);
    expect(tabs().byThread).toEqual({});
    expect(tabs().titles).toEqual({});
  });
});
