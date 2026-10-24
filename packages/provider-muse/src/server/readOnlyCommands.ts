/**
 * Conservative read-only shell command classifier for T3's "auto" runtime mode
 * on Muse. Muse has no native mode between `:ask-me` and `:unrestricted`, so an
 * inherited "auto" child used to step down to approval-required and wait on a
 * person for every `ls` or `git status`. Only commands accepted here are
 * approved without asking; everything else is shown as before.
 *
 * Rules are strict: no expansion, globbing, quoting, redirection, pipes,
 * subshells or job control. `&&` chains pass only when every segment passes,
 * with a bare `cd <dir>` allowed as a segment.
 */
const SIMPLE_READ_ONLY = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "which",
  "rg",
  "grep",
  "tree",
  "df",
  "date",
  "whoami",
  "uname",
]);

const GIT_READ_ONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
]);

// Arguments that can write files or run other programs.
const FORBIDDEN_ARG =
  /^(-o$|--output(=|$)|--ext-diff$|--textconv$|--pre(=|$)|--exec(=|$)|--hostname-bin(=|$)|--files0-from(=|$))/;

const FIND_FORBIDDEN = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

// Expansion, redirection, quoting, globbing, escapes and job control.
const UNSAFE_CHARS = /[;|&<>`$(){}\\\n\r*?[\]~!"'#=]/;

function segmentIsReadOnly(segment: string): boolean {
  const words = segment
    .trim()
    .split(/[ \t]+/)
    .filter((word) => word.length > 0);
  const [head, ...args] = words;
  if (head === undefined) return false;
  if (args.some((arg) => FORBIDDEN_ARG.test(arg))) return false;
  if (head === "cd") return args.length === 1;
  if (SIMPLE_READ_ONLY.has(head)) return true;
  if (head === "find") return !args.some((arg) => FIND_FORBIDDEN.has(arg));
  if (head === "git") {
    // `git -C <dir> <sub>` is allowed; other global options (e.g. -c) are not.
    let rest = args;
    while (rest[0] === "-C" && rest[1] !== undefined) rest = rest.slice(2);
    const [sub] = rest;
    return sub !== undefined && GIT_READ_ONLY.has(sub);
  }
  return false;
}

export function isReadOnlyCommand(command: string | undefined): boolean {
  if (command === undefined) return false;
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) return false;
  const segments = trimmed.split("&&");
  if (segments.some((segment) => UNSAFE_CHARS.test(segment))) return false;
  if (!segments.every(segmentIsReadOnly)) return false;
  return segments.some((segment) => !/^\s*cd\b/.test(segment));
}
