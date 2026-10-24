/**
 * Conservative read-only shell command classifier for T3's "auto" runtime mode
 * on Muse. Muse has no native mode between `:ask-me` and `:unrestricted`, so an
 * inherited "auto" child used to step down to approval-required and wait on a
 * person for every `ls`. Only commands accepted here are approved without
 * asking; everything else is shown as before.
 *
 * Rules are strict: no expansion, globbing, quoting, redirection, pipes,
 * subshells or job control. `&&` chains pass only when every segment passes,
 * with a bare `cd <dir>` allowed as a segment. Every option must be on a
 * per-command allowlist (attached and combined short forms are checked letter
 * by letter). Commands that read configuration able to run helpers (git via
 * core.fsmonitor/diff drivers/pager, rg via RIPGREP_CONFIG_PATH) are never
 * auto-approved.
 */
interface CommandSpec {
  /** Short flags that take no value; may be combined (`-la`). */
  readonly short: string;
  /** Flags that take one numeric value, either attached (`-n5`) or next word. */
  readonly numeric?: ReadonlySet<string>;
  /** Long flags without a value. */
  readonly long?: ReadonlySet<string>;
  /** Allow `-<digits>` (head/tail). */
  readonly bareNumber?: boolean;
  /** Allow non-option operands (paths). */
  readonly operands: boolean;
}

const SPECS: ReadonlyMap<string, CommandSpec> = new Map(
  Object.entries({
    ls: { short: "1aAdFhilLnRrStu", long: new Set(["--all", "--long"]), operands: true },
    pwd: { short: "LP", operands: false },
    cat: { short: "nbsvAETe", operands: true },
    head: { short: "qv", numeric: new Set(["-n", "-c"]), bareNumber: true, operands: true },
    tail: { short: "qvfF", numeric: new Set(["-n", "-c"]), bareNumber: true, operands: true },
    wc: { short: "lwcmL", operands: true },
    stat: { short: "L", operands: true },
    which: { short: "a", operands: true },
    whoami: { short: "", operands: false },
    uname: { short: "amnrsvpio", operands: false },
    tree: { short: "adfFiClsh", numeric: new Set(["-L"]), operands: true },
    grep: {
      short: "rRniIlLcEFwvxHhsoq",
      numeric: new Set(["-m", "-A", "-B", "-C"]),
      operands: true,
    },
  } satisfies Record<string, CommandSpec>),
);

// `find` predicates that only test or print to stdout.
const FIND_PREDICATES_WITH_VALUE = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-type",
  "-maxdepth",
  "-mindepth",
  "-size",
  "-mtime",
  "-mmin",
  "-newer",
]);
const FIND_PREDICATES = new Set(["-print", "-print0", "-empty", "-not", "-o", "-a", "-depth"]);

// Expansion, redirection, quoting, globbing, escapes and job control.
const UNSAFE_CHARS = /[;|&<>`$(){}\\\n\r*?[\]~!"'#=]/;
const ASCII_WORD = /^[A-Za-z0-9._/+:@%,-]+$/;
const DIGITS = /^\d+$/;

function argsMatchSpec(spec: CommandSpec, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-") || arg === "-") {
      if (!spec.operands) return false;
      continue;
    }
    if (arg.startsWith("--")) {
      if (spec.long?.has(arg) !== true) return false;
      continue;
    }
    if (spec.bareNumber === true && DIGITS.test(arg.slice(1))) continue;
    const flag = arg.slice(0, 2);
    if (spec.numeric?.has(flag) === true) {
      const attached = arg.slice(2);
      if (attached.length > 0) {
        if (!DIGITS.test(attached)) return false;
      } else {
        const value = args[index + 1];
        if (value === undefined || !DIGITS.test(value)) return false;
        index += 1;
      }
      continue;
    }
    for (const letter of arg.slice(1)) {
      if (!spec.short.includes(letter)) return false;
    }
  }
  return true;
}

function findIsReadOnly(args: readonly string[]): boolean {
  let index = 0;
  // Leading start paths.
  while (index < args.length && !args[index]!.startsWith("-")) index += 1;
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (FIND_PREDICATES.has(arg)) continue;
    if (FIND_PREDICATES_WITH_VALUE.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return false;
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function segmentIsReadOnly(segment: string): boolean {
  const words = segment
    .trim()
    .split(/[ \t]+/)
    .filter((word) => word.length > 0);
  if (!words.every((word) => ASCII_WORD.test(word))) return false;
  const [head, ...args] = words;
  if (head === undefined) return false;
  if (head === "cd") return args.length === 1 && !args[0]!.startsWith("-");
  if (head === "find") return findIsReadOnly(args);
  const spec = SPECS.get(head);
  return spec !== undefined && argsMatchSpec(spec, args);
}

export function isReadOnlyCommand(command: string | undefined): boolean {
  if (command === undefined) return false;
  // Printable ASCII, spaces and tabs only, checked before trimming: JS trim() strips characters
  // (NBSP, CR, Unicode spaces) that a shell treats as part of a word.
  if (!/^[\x20-\x7e\t]*$/.test(command)) return false;
  const trimmed = command.replace(/^[ \t]+|[ \t]+$/g, "");
  if (trimmed.length === 0 || trimmed.length > 2000) return false;
  const segments = trimmed.split("&&");
  if (segments.some((segment) => UNSAFE_CHARS.test(segment))) return false;
  if (!segments.every(segmentIsReadOnly)) return false;
  return segments.some((segment) => !/^[ \t]*cd\b/.test(segment));
}
