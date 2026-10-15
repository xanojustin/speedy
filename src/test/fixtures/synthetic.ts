// A synthetic long session for virtualization and reducer-speed tests.
import type { ThreadAction } from "../../store/reducer";

/** `count` actions cycling through user, thinking, text, tool_use, tool_result, text, result. */
export function syntheticSession(count: number): ThreadAction[] {
  const out: ThreadAction[] = [];
  let seq = 0;
  let turn = 0;
  while (out.length < count) {
    turn++;
    const id = `msg_${turn}`;
    const tool = `tu_${turn}`;
    const msg = (raw: Record<string, unknown>): ThreadAction => ({ kind: "message", seq: ++seq, raw: raw as never });
    const steps: ThreadAction[] = [
      { kind: "local_user", id: `u_${turn}`, content: [{ type: "text", text: `Question ${turn}: please look at file ${turn}.ts` }], ts: turn * 1000 },
      msg({ type: "assistant", parent_tool_use_id: null, message: { id, content: [{ type: "thinking", thinking: `Thinking about ${turn}` }] } }),
      msg({
        type: "assistant",
        parent_tool_use_id: null,
        message: { id, content: [{ type: "text", text: `Looking at **file ${turn}**.\n\n- one\n- two\n\n\`\`\`ts\nconst x = ${turn};\n\`\`\`` }] },
      }),
      msg({ type: "assistant", parent_tool_use_id: null, message: { id, content: [{ type: "tool_use", id: tool, name: "Read", input: { file_path: `/src/file${turn}.ts` } }] } }),
      msg({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: `contents of ${turn}` }] } }),
      msg({ type: "assistant", parent_tool_use_id: null, message: { id: `${id}b`, content: [{ type: "text", text: `Done with ${turn}.` }] } }),
      msg({ type: "result", subtype: "success", is_error: false }),
    ];
    out.push(...steps);
  }
  return out.slice(0, count);
}
