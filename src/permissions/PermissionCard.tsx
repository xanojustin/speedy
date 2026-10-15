// U10: inline permission / plan-approval / AskUserQuestion card for one pending request. STUB.
export function PermissionCard({ threadId, requestId }: { threadId: string; requestId: string }) {
  return <div className="permission-card" data-thread={threadId} data-request={requestId} />;
}
