// U11: per-project past-conversations popover. STUB.
export function SessionList({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  return <div className="session-list" data-project={projectId} onClick={onClose} />;
}
