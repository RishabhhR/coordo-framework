import { execFileSync } from "node:child_process";

// A failed git invocation, keeping the exit status and stderr so callers can
// tell "git answered no" (e.g. the object doesn't exist) apart from "git
// itself is broken" (not installed, unaccepted Xcode license -> exit 69, not a
// repository). `reason` is the first line of stderr, or the best fallback.
export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly status: number | null,
    readonly stderr: string,
    readonly reason: string
  ) {
    super(`git ${args.join(" ")} failed: ${reason}`);
  }
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

// execFileSync (argument array, no shell) rather than execSync (string,
// through a shell) - checkpoint can come from a user-supplied `--ref` value,
// and interpolating that into a shell string would be a command-injection
// risk for a value that's otherwise entirely local/trusted-by-convention.
function git(projectRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf-8",
      // Capture stderr rather than letting it spill onto the terminal, so it
      // is reported once, in context, by whoever handles the GitError.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string };
    if (e.code === "ENOENT") {
      throw new GitError(args, null, "", "git executable not found on PATH");
    }
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const status = e.status ?? null;
    const reason = firstLine(stderr) || (status !== null ? `exited with code ${status}` : e.message);
    throw new GitError(args, status, stderr, reason);
  }
}

// Why git can't be used in projectRoot, or null if it can. Checked before
// interpreting any other git failure: when git itself is broken every command
// fails, and those failures must not be mistaken for answers about the repo.
function gitUnusableReason(projectRoot: string): string | null {
  try {
    git(projectRoot, ["rev-parse", "--git-dir"]);
    return null;
  } catch (err) {
    return (err as GitError).reason;
  }
}

// `git cat-file -e` reports a well-formed but absent object as exit 1 with no
// output, and an unresolvable name as exit 128 "Not a valid object name".
// Anything else is git failing, not an answer about the object.
function isMissingObject(err: GitError): boolean {
  return (err.status === 1 && err.stderr.trim() === "")
    || (err.status === 128 && /Not a valid object name/i.test(err.stderr));
}

export function getGitHead(projectRoot: string): string {
  try {
    return git(projectRoot, ["rev-parse", "HEAD"]).trim();
  } catch (err) {
    throw new Error(`Failed to get current Git HEAD: ${(err as GitError).reason}`);
  }
}

// Why coordo-lead can't commit in projectRoot (git broken, or not a repo), or null.
export function commitBlocker(projectRoot: string): string | null {
  return gitUnusableReason(projectRoot);
}

// Uncommitted paths (tracked or not, minus ignored files), porcelain format.
export function uncommittedChanges(projectRoot: string): string[] {
  return git(projectRoot, ["status", "--porcelain"]).split("\n").filter((line) => line.trim() !== "");
}

// Commits everything in the working tree. Returns the new short sha, or null
// when there was nothing to commit. Throws GitError if git refuses.
export function commitAll(projectRoot: string, message: string): string | null {
  if (uncommittedChanges(projectRoot).length === 0) return null;
  git(projectRoot, ["add", "-A"]);
  git(projectRoot, ["commit", "-q", "-m", message]);
  return git(projectRoot, ["rev-parse", "--short", "HEAD"]).trim();
}

export function runGitDigest(
  projectRoot: string,
  checkpoint: string | undefined,
  fullDiff = false
): string {
  // Never suggest resetting the checkpoint here: that would silently skip
  // whatever commits landed since it, which is what digest exists to surface.
  const unusable = gitUnusableReason(projectRoot);
  if (unusable) {
    const kept = checkpoint ? `Checkpoint '${checkpoint}' was not checked and is unchanged. ` : "";
    throw new Error(`git is not usable here: ${unusable}
${kept}Fix git, then re-run 'coordo digest'.`);
  }

  if (!checkpoint) {
    const fallbackLog = git(projectRoot, ["log", "-n", "20", "--oneline"]);
    return `⚠️ No checkpoint recorded yet. Here are the last 20 commits:

${fallbackLog}
💡 Run 'coordo checkpoint --as <name>' to establish a checkpoint!`;
  }

  try {
    // Check if checkpoint exists in git history
    git(projectRoot, ["cat-file", "-e", checkpoint]);
  } catch (err) {
    const gitErr = err as GitError;
    if (!isMissingObject(gitErr)) {
      throw new Error(`Could not verify checkpoint '${checkpoint}': ${gitErr.reason}
The checkpoint is unchanged. Fix the problem above, then re-run 'coordo digest'.`);
    }
    return `⚠️ Checkpoint commit '${checkpoint}' not found in Git history. It might have been rebased or deleted.
Run 'coordo checkpoint --as <name>' to reset it to current HEAD.`;
  }

  const range = `${checkpoint}..HEAD`;
  try {
    const commitCount = git(projectRoot, ["rev-list", "--count", range]).trim();
    if (parseInt(commitCount, 10) === 0) {
      return "✅ No new commits since last checkpoint.";
    }

    if (fullDiff) {
      return git(projectRoot, ["diff", range]);
    } else {
      return git(projectRoot, ["log", range, "--oneline", "--stat"]);
    }
  } catch (err) {
    return `Failed to compute digest for range ${range}: ${(err as GitError).reason}`;
  }
}
