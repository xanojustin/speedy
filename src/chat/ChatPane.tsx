// U8: transcript + inline permission cards + error card + composer for one thread.
// Mounted only for the selected thread (KTD2); the thread's state lives in the store either way.
import { useEffect } from "react";
import { Composer } from "../composer/Composer";
import { loadSessionHistory } from "../store/runtime";
import { ChatHeader } from "./ChatHeader";
import { Transcript } from "./Transcript";
import "./chat.css";

export function ChatPane({ threadId }: { threadId: string }) {
  useEffect(() => {
    // App relaunch: a thread with a session id but no transcript yet is seeded from the CLI's JSONL.
    void loadSessionHistory(threadId);
  }, [threadId]);

  return (
    <div className="chat-pane" data-thread={threadId}>
      <ChatHeader threadId={threadId} />
      <Transcript threadId={threadId} />
      <Composer threadId={threadId} />
    </div>
  );
}
