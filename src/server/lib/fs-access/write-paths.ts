import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { lstat } from "node:fs/promises";
import { expandTilde, resolveSafePath, type SafePath } from "./paths";

/**
 * Phase B write-path safety. resolveSafePath is the base (unchanged); this
 * adds the guards write access needs that read access did not:
 *
 * Jarvis ingests attacker-controlled text through Composio Gmail/Slack. If an
 * injected instruction could write ~/.zshrc or ~/Library/LaunchAgents, one
 * prompt injection becomes persistent code execution. The approval card is the
 * primary defence; these paths must additionally be structurally unreachable.
 */

// Home-relative subtrees refused for WRITES unconditionally (persistence vectors)
const WRITE_DENY_SUBPATHS = [
  // launch persistence
  "Library/LaunchAgents",
  "Library/LaunchDaemons",
  "Library/Application Support/com.apple.backgroundtaskmanagementagent",
  // shell + login persistence
  ".zshrc", ".zshenv", ".zprofile", ".zlogin",
  ".bashrc", ".bash_profile", ".profile", ".inputrc",
  ".config/fish", ".zsh_sessions",
  // remote access (already denied for read; restated for write clarity)
  ".ssh",
  // scheduled execution
  "Library/Preferences/com.apple.loginitems.plist",
  // editor / tooling auto-execution
  ".vscode/tasks.json", ".vscode/launch.json", ".vscode/settings.json",
  ".cursor", ".idea",
  // Jarvis's own state
  "Library/Application Support/NimitsJarvis",
];

// Refused anywhere in the tree, at any depth
const WRITE_DENY_ANYWHERE = [
  ".git/hooks", // pre-commit hooks execute on the operator's next commit
  ".git/config", // core.fsmonitor and aliases execute arbitrary commands
  "node_modules", // huge, generated, supply-chain vector
  ".env", // already denied for read
];

// Outside home anyway — denied explicitly so the message is intelligible
const SYSTEM_PREFIXES = ["/System", "/Library", "/usr", "/bin", "/sbin", "/opt"];

export const MAX_WRITE_BYTES = 1_000_000; // 1 MB per operation
export const MAX_CHANGES_PER_MESSAGE = 1;

/** Repo root at startup — the agent must not edit the application running it. */
const REPO_ROOT = process.cwd();

export interface WritePathError {
  code:
    | "OUTSIDE_ROOT"
    | "DENIED_PATH"
    | "PERSISTENCE_DENIED"
    | "SYSTEM_PATH"
    | "REPO_TREE"
    | "SYMLINK_TARGET"
    | "PARENT_MISSING"
    | "NOT_FOUND"
    | "TCC_BLOCKED"
    | "NO_PERMISSION"
    | "TOO_LARGE"
    | "BAD_PATH";
  message: string;
}

type WriteCheck = { op: string; bytes?: number };

/**
 * Resolve a path for WRITE. Order:
 *   1. Phase A resolveSafePath (tilde, realpath-deepest, containment, read deny-list)
 *   2. system prefixes (intelligible message instead of OUTSIDE_ROOT)
 *   3. repo-tree denial (process.cwd())
 *   4. persistence denylist (subpaths + anywhere patterns)
 *   5. symlink-final-component refusal
 *   6. size cap
 * Callers add their own existence checks (create-on-existing, parent-missing).
 */
export async function resolveWritePath(
  input: string,
  root: string | null | undefined,
  check: WriteCheck = { op: "write" },
): Promise<{ ok: true; path: string } | { ok: false; error: WritePathError }> {
  if (check.bytes !== undefined && check.bytes > MAX_WRITE_BYTES) {
    return {
      ok: false,
      error: {
        code: "TOO_LARGE",
        message: `Write of ${check.bytes} bytes exceeds the ${MAX_WRITE_BYTES}-byte per-operation limit. Large generated data belongs in a script artifact.`,
      },
    };
  }

  // System prefixes FIRST — checked on the expanded input so the operator gets
  // an intelligible error instead of a generic containment failure.
  const expandedInput = expandTilde(input);
  if (isAbsolute(expandedInput) && SYSTEM_PREFIXES.some((p) => expandedInput === p || expandedInput.startsWith(p + sep))) {
    return {
      ok: false,
      error: {
        code: "SYSTEM_PATH",
        message: `${expandedInput} is a macOS system location and is never writable through Jarvis.`,
      },
    };
  }

  // Symlink final component — checked on the PRE-realpath input.
  // resolveSafePath resolves through symlinks, so a symlink whose target is
  // inside the root would otherwise pass containment invisibly. Writing
  // through a link is rarely the intent and is a common escape shape.
  const rootExpanded = expandTilde(root?.trim() || homedir());
  if (isAbsolute(expandedInput)) {
    try {
      const st = await lstat(expandedInput);
      if (st.isSymbolicLink()) {
        return {
          ok: false,
          error: {
            code: "SYMLINK_TARGET",
            message: `${expandedInput} is a symbolic link. Jarvis refuses to write through symlinks — propose the resolved target instead.`,
          },
        };
      }
    } catch {
      // ENOENT — fine for create/mkdir; containment still applies below
    }
  }

  const safe: SafePath = await resolveSafePath(input, root);
  if (!safe.ok) {
    return {
      ok: false,
      error: {
        code: safe.code === "DENIED_PATH" ? "PERSISTENCE_DENIED" : (safe.code as WritePathError["code"]),
        message: safe.message,
      },
    };
  }
  const real = safe.path;

  // System prefixes — outside home anyway (double-check on the resolved path)
  if (SYSTEM_PREFIXES.some((p) => real === p || real.startsWith(p + sep))) {
    return {
      ok: false,
      error: {
        code: "SYSTEM_PATH",
        message: `${real} is a macOS system location and is never writable through Jarvis.`,
      },
    };
  }

  // Repo tree — the agent must not edit the application that is running it.
  if (real === REPO_ROOT || real.startsWith(REPO_ROOT + sep)) {
    return {
      ok: false,
      error: {
        code: "REPO_TREE",
        message:
          "That path is inside the Jarvis application tree. Jarvis cannot modify its own source.",
      },
    };
  }

  // Deny anywhere-in-tree patterns (applied to the realpathed result)
  const segments = real.split(sep);
  for (const d of WRITE_DENY_ANYWHERE) {
    const parts = d.split("/");
    for (let i = 0; i <= segments.length - parts.length; i++) {
      if (parts.every((p, j) => segments[i + j] === p)) {
        return {
          ok: false,
          error: {
            code: "PERSISTENCE_DENIED",
            message: `Writes to "${d}" are permanently blocked — it can execute code on this machine.`,
          },
        };
      }
    }
  }

  // Home-relative subpath denylist
  const home = homedir();
  const relHome = real.startsWith(home + sep) ? real.slice(home.length + 1) : "";
  if (relHome) {
    for (const d of WRITE_DENY_SUBPATHS) {
      if (relHome === d || relHome.startsWith(d + sep)) {
        return {
          ok: false,
          error: {
            code: "PERSISTENCE_DENIED",
            message: `Writes to ${d} are permanently blocked — that location can persist code execution across restarts.`,
          },
        };
      }
    }
  }

  // Refuse when the FINAL component is itself a symlink, even if the target is
  // inside the root — writing through a link is rarely the intent.
  try {
    const st = await lstat(real);
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        error: {
          code: "SYMLINK_TARGET",
          message: `${real} is a symbolic link. Jarvis refuses to write through symlinks — propose the resolved target instead.`,
        },
      };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Target doesn't exist — that's fine for create/mkdir; parent existence
      // is the caller's check. But verify the PARENT isn't a symlink-hole for
      // non-existent targets: realpathDeepest already handled that containment.
      return { ok: true, path: real };
    }
    if (code === "EPERM") {
      return {
        ok: false,
        error: {
          code: "TCC_BLOCKED",
          message:
            "macOS privacy settings blocked this path. Grant Full Disk Access to the app running Jarvis in System Settings > Privacy & Security, then restart it.",
        },
      };
    }
    return {
      ok: false,
      error: { code: "BAD_PATH", message: `Filesystem error (${code}).` },
    };
  }

  return { ok: true, path: real };
}

/** Absolute + rooted check used by fs_move to refuse root-crossing moves. */
export function isInsideRoot(p: string, root: string): boolean {
  const abs = resolve(p);
  return isAbsolute(abs) && (abs === root || abs.startsWith(root + sep));
}
