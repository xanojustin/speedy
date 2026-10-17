// Where a transcript file link points, as a path relative to the thread's folder.
import { filesSearch, pathsExist } from "../ipc/commands";

/**
 * Resolves `path` (relative, `./`-prefixed, or absolute under `root`) to a path relative to `root`.
 * A path that doesn't exist as written (a bare `Composer.tsx`, or one relative to a subfolder) is
 * looked up by name and matched on its trailing folders. Null when it points outside `root`.
 */
export async function resolveReveal(root: string, path: string): Promise<string | null> {
  const base = `${root.replace(/\/+$/, "")}/`;
  let rel = path;
  if (rel.startsWith("/")) {
    if (!rel.startsWith(base)) return null;
    rel = rel.slice(base.length);
  }
  rel = rel.replace(/^(?:\.\/)+/, "");
  if (rel === "" || rel.split("/").includes("..")) return null;

  const [exists] = await pathsExist([base + rel]).catch(() => [false]);
  if (exists) return rel;
  const name = rel.split("/").pop()!;
  const hits = await filesSearch(root, name, 50, false).catch(() => []);
  const match = hits.find((h) => !h.isDir && (h.path === rel || h.path.endsWith(`/${rel}`)));
  // Not found anywhere: open it anyway so the explorer says it couldn't be read.
  return match?.path ?? rel;
}
