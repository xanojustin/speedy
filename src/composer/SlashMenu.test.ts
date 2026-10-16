import { describe, expect, it } from "vitest";
import { expandSlash, type SlashCommand } from "./SlashMenu";

const cmd = (name: string): SlashCommand => ({ name, description: "", argumentHint: "" });

describe("expandSlash", () => {
  const commands = [cmd("compact"), cmd("compound-engineering:ce-plan"), cmd("a:dup"), cmd("b:dup"), cmd("x:compact")];

  it("expands a unique plugin short name, keeping the arguments", () => {
    expect(expandSlash("/ce-plan add caching", commands)).toBe("/compound-engineering:ce-plan add caching");
    expect(expandSlash("/ce-plan", commands)).toBe("/compound-engineering:ce-plan");
  });

  it("leaves exact names, ambiguous short names, unknown names and plain text alone", () => {
    expect(expandSlash("/compact", commands)).toBe("/compact");
    expect(expandSlash("/dup x", commands)).toBe("/dup x");
    expect(expandSlash("/nope", commands)).toBe("/nope");
    expect(expandSlash("/ce-planner", commands)).toBe("/ce-planner");
    expect(expandSlash("hi /ce-plan", commands)).toBe("hi /ce-plan");
    expect(expandSlash("/ce-plan", null)).toBe("/ce-plan");
  });
});
