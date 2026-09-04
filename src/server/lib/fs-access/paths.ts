import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

/**
 * Phase A path-safety boundary. Every path originating from the model passes
 * through resolveSafePath before any filesystem call.
 *
 * Order is not negotiable:
 *   1. expand ~            (Node does not; fs.readFile("~/x") is ENOENT)
 *   2. path.resolve        (absolute)
 *   3. realpath the deepest existing ancestor (defeats symlink escapes)
 *   4. containment check   against the resolved root
 *   5. deny-list           applied to the REALPATHED result — never the raw
 *                          input, or `notes.txt -> ~/.ssh/id_rsa` slips through
 */

export type PathErrorCode =
  | "OUTSIDE_ROOT"
  | "DENIED_PATH"
  | "NOT_FOUND"
  | "TCC_BLOCKED"
  | "NO_PERMISSION"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "BAD_PATH";

export type SafePath =
  | { ok: true; path: string }
  | { ok: false; code: PathErrorCode; message: string };

// Any path segment equal to one of these is refused.
// Build/dependency/vcs noise first (node_modules, .git, ...) — listing or
// searching them wastes thousands of entries and syscalls. Also: an unbounded
// walk of a home directory is only tractable because these are denied.
const DENY_SEGMENTS = new Set([
  ".ssh", ".aws", ".gnupg", ".gpg", ".kube", ".docker", "Keychains",
  "node_modules", ".git", "__pycache__", ".venv", ".next",
  ".pnpm-store", ".Trash", "dist", "build",
]);

// Exact file names refused anywhere in the tree.
const DENY_BASENAMES = new Set([
  ".env", ".env.local", ".env.production", ".netrc", ".git-credentials",
  ".npmrc", "credentials", "id_rsa", "id_ed25519", "id_ecdsa",
]);

const DENY_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keychain", ".keychain-db"];

// Home-relative subtrees refused wholesale.
// Library as a whole tree is deliberate: TCC databases, speech transcripts,
// accountd records — no user-facing task needs the agent browsing there.
// (If ever needed, add an explicit allowSystemPaths arg gated on full mode.)
const DENY_SUBPATHS = [
  "Library",
  ".config/gh",
  ".config/gcloud",
  ".local/share/keyrings",
];

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p; // "~user" is intentionally NOT supported
}

/** realpath the deepest existing ancestor, then re-append the missing tail. */
async function realpathDeepest(abs: string): Promise<string> {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const rp = await realpath(cur);
      return tail.length ? resolve(rp, ...tail.slice().reverse()) : rp;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err; // EPERM/EACCES must propagate
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the filesystem root
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

function isDenied(real: string, root: string): boolean {
  const rel = real.startsWith(root + sep) ? real.slice(root.length + 1) : "";
  const segments = real.split(sep);
  if (segments.some((s) => DENY_SEGMENTS.has(s))) return true;
  const base = basename(real);
  if (DENY_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  const lower = base.toLowerCase();
  if (DENY_EXTENSIONS.some((e) => lower.endsWith(e))) return true;
  if (rel && DENY_SUBPATHS.some((d) => rel === d || rel.startsWith(d + sep))) return true;
  return false;
}

/**
 * Cheap string-only deny check for a path the caller already knows is inside
 * the realpathed root and is NOT a symlink — the parent having been
 * realpathed, a non-symlink child cannot escape containment, so the full
 * resolveSafePath (realpath syscalls) is unnecessary for listing/searching.
 * Apply the deny-list to the literal path; identical result to isDenied()
 * because realpath(full) === full for a non-symlink child of a real parent.
 */
export function isDeniedByName(abs: string, rootOverride?: string | null): boolean {
  return isDenied(abs, expandTilde(rootOverride?.trim() || homedir()));
}

/** Map a filesystem error to a SafePath failure with an operator-actionable message. */
export function mapErrno(err: unknown, path: string, hadTilde = false): SafePath {
  const code = (err as NodeJS.ErrnoException)?.code ?? "Unknown";
  switch (code) {
    case "EPERM":
      return {
        ok: false,
        code: "TCC_BLOCKED",
        message:
          "macOS privacy settings blocked this path. Grant Full Disk Access to the app running Jarvis in System Settings > Privacy & Security, then restart it.",
      };
    case "ENOENT":
      return {
        ok: false,
        code: "NOT_FOUND",
        message: `No such file or directory: ${path}${hadTilde ? ` (the ~ was expanded to ${homedir()})` : ""}`,
      };
    case "EACCES":
      return { ok: false, code: "NO_PERMISSION", message: "Permission denied by file permissions." };
    case "EISDIR":
      return { ok: false, code: "NOT_A_FILE", message: "That is a directory — use fs_list." };
    case "ENOTDIR":
      return { ok: false, code: "NOT_A_DIRECTORY", message: "That is a file — use fs_read." };
    case "ELOOP":
      return { ok: false, code: "BAD_PATH", message: "Too many symbolic links." };
    case "EMFILE":
      return { ok: false, code: "BAD_PATH", message: "Too many open files; try a narrower listing." };
    default:
      return { ok: false, code: "BAD_PATH", message: `Filesystem error (${code}).` };
  }
}

export async function resolveSafePath(
  input: string,
  rootOverride?: string | null,
): Promise<SafePath> {
  if (!input || typeof input !== "string") {
    return { ok: false, code: "BAD_PATH", message: "No path supplied." };
  }
  if (input.includes("\0")) {
    return { ok: false, code: "BAD_PATH", message: "Path contains a null byte." };
  }
  const hadTilde = input.startsWith("~");

  let root: string;
  try {
    root = await realpath(expandTilde(rootOverride?.trim() || homedir()));
  } catch (err) {
    return mapErrno(err, rootOverride ?? "~", hadTilde);
  }

  const abs = resolve(root, expandTilde(input));

  let real: string;
  try {
    real = await realpathDeepest(abs);
  } catch (err) {
    return mapErrno(err, abs, hadTilde);
  }

  if (real !== root && !real.startsWith(root + sep)) {
    return {
      ok: false,
      code: "OUTSIDE_ROOT",
      message: `Path is outside the permitted root (${root}).`,
    };
  }
  if (isDenied(real, root)) {
    return {
      ok: false,
      code: "DENIED_PATH",
      message: "That location is permanently blocked (credentials or system data).",
    };
  }
  return { ok: true, path: real };
}
