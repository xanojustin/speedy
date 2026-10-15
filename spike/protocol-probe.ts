// U1 protocol spike (throwaway). Spawns claude with the KTD4 contract, records NDJSON.
// Every can_use_tool request is DENIED, so no tool ever executes; the round trip is still proven.
import { spawn } from "child_process";
import { writeFileSync } from "fs";
const cwd = process.argv[2]; const out = process.argv[3];
const args = ["--output-format","stream-json","--verbose","--input-format","stream-json",
  "--include-partial-messages","--permission-prompt-tool","stdio","--permission-mode","default","--model","haiku"];
const child = spawn("claude", args, { cwd, env: { ...process.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true" }, stdio: ["pipe","pipe","pipe"] });
const log: any[] = [];
const send = (o: any) => { log.push({ dir: "out", msg: o }); child.stdin.write(JSON.stringify(o) + "\n"); };
const t0 = Date.now(); const stamp = (m: string) => console.log(`[${Date.now()-t0}ms] ${m}`);
let buf = ""; let sawPartial = false; let interrupted = false;
child.stdout.on("data", (d) => { buf += d.toString(); let i;
  while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i+1); if (!line.trim()) continue;
    let m: any; try { m = JSON.parse(line); } catch { stamp("UNPARSEABLE " + line.slice(0,100)); continue; }
    log.push({ dir: "in", msg: m });
    const tag = m.type + (m.subtype ? "/"+m.subtype : "") + (m.request?.subtype ? " req="+m.request.subtype : "") + (m.response?.subtype ? " resp="+m.response.subtype+" id="+m.response.request_id : "");
    if (m.type === "stream_event") { if (!sawPartial) stamp("first stream_event " + m.event?.type); sawPartial = true; continue; }
    stamp(tag);
    if (m.type === "control_response" && m.response.request_id === "init-1") {
      send({ type: "user", message: { role: "user", content: [{ type: "text", text: "Use the Bash tool (not Write) to run exactly: touch ./speedy-probe.txt  -- do not use any scratchpad. If denied, reply with the single word denied." }] }, parent_tool_use_id: null, session_id: "" }); }
    if (m.type === "control_request" && m.request.subtype === "can_use_tool") {
      stamp("can_use_tool tool=" + m.request.tool_name + " keys=" + Object.keys(m.request).join(","));
      send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { behavior: "deny", message: "Denied by Speedy protocol probe." } } });
    }
    if (m.type === "result" && !interrupted) { interrupted = true;
      send({ type: "user", message: { role: "user", content: [{ type: "text", text: "Write the numbers 1 to 300 as words, one per line. No tools." }] }, parent_tool_use_id: null, session_id: "" });
      setTimeout(() => send({ type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } }), 3000);
    } else if (m.type === "result" && interrupted) { stamp("result after interrupt -> done"); finish(); }
  } });
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d));
send({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
function finish() { writeFileSync(out, log.map(l => JSON.stringify(l)).join("\n") + "\n"); console.log("partials:", sawPartial, "lines:", log.length); child.stdin.end(); setTimeout(()=>process.exit(0), 500); }
setTimeout(() => { stamp("TIMEOUT"); finish(); }, 120000);
