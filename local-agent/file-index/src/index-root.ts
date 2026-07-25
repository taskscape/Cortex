import path from "node:path";
import { HttpError } from "@local-agent/http-utils";
import { isRealPathInside, type WorkspaceConfig } from "@local-agent/paths";

// The requested root is an authorization decision, not a convenience: `/index` reads whatever tree it
// is given and `/search` serves the contents back, so an unchecked root reads arbitrary files off the
// host. Configured roots are the boundary — a request may narrow to a subtree of one, never leave it.
// Containment is checked against the *resolved* path so a junction planted inside a configured root
// cannot redirect the walk outside it.
export async function resolveIndexRoot(requested: string | undefined, config: WorkspaceConfig): Promise<string> {
  if (requested === undefined) {
    const fallback = config.roots[0]?.path;
    if (fallback === undefined) {
      throw new HttpError(400, "No root supplied and no configured roots exist.");
    }

    return path.resolve(fallback);
  }

  for (const root of config.roots) {
    if (await isRealPathInside(requested, root.path)) {
      return path.resolve(requested);
    }
  }

  // Deliberately does not echo the requested path or say whether it exists.
  throw new HttpError(403, "Requested root is outside the configured workspace roots.");
}
