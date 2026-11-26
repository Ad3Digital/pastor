import { describe, expect, test } from "bun:test";
import { delimiter, join, resolve } from "node:path";

import { hostFor } from "../bridge/host.ts";
import { capture, context, fakeFiles, fakeLinkFs, HOME, posixKey, ROOT } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  classifyLink,
  classifyUnlink,
  cmdLink,
  cmdUnlink,
  isPastorBinaryPath,
  type LinkDeps,
  linkDir,
  linkPath,
  onPath,
  resolveLinkTarget,
} from "./link.ts";
import { pastorBinary } from "./unit.ts";

// `pastor link` / `pastor unlink`. The decisions are pure functions of what is at the destination
// (ADR 0021), so they are pinned directly; the two verbs are then only asserted for what they
// actually DO with a verdict — which write happens, which does not, and what the operator reads.

// Paths the code builds are spelled the way it builds them (`join`), so they hold on Windows too. The
// fake filesystems fold their keys to POSIX, which is why a recorded op is compared through `posixKey`.
const AT = join(HOME, ".local", "bin", "pastor");
const DIR = join(HOME, ".local", "bin");
/** This checkout's compiled binary — `bin/pastor` on POSIX, `bin/pastor.exe` on Windows. */
const BINARY = pastorBinary(ROOT);
/** Another instance's checkout — a real pastor binary, and not ours. */
const OTHER = "/opt/pastor-v1/bin/pastor";

const symlink = (target: string) => ({ kind: "symlink", target }) as const;

function deps(
  over: {
    seed?: Record<string, ReturnType<typeof symlink> | { kind: "absent" } | { kind: "other"; what: string }>;
    built?: boolean;
    path?: string;
  } = {},
): LinkDeps & { io: ReturnType<typeof capture>; fs: ReturnType<typeof fakeLinkFs> } {
  const io = capture();
  const fs = fakeLinkFs(over.seed);
  const files = fakeFiles(over.built === false ? {} : { [BINARY]: "#!/bin/pastor" });
  return { ctx: context({ PATH: over.path ?? ["/usr/bin", DIR].join(delimiter) }), io, files, fs };
}

describe("the published name", () => {
  test("is ~/.local/bin/pastor", () => {
    expect(linkDir(HOME)).toBe(DIR);
    expect(linkPath(HOME)).toBe(AT);
  });

  test("a relative link target resolves against the link's own directory", () => {
    expect(resolveLinkTarget(AT, "../../src/pastor/bin/pastor")).toBe(resolve(HOME, "src", "pastor", "bin", "pastor"));
    expect(resolveLinkTarget(AT, BINARY)).toBe(BINARY);
  });

  test("a pastor binary is recognised by its shape, on either separator", () => {
    expect(isPastorBinaryPath("/opt/pastor/bin/pastor")).toBe(true);
    expect(isPastorBinaryPath(OTHER)).toBe(true);
    expect(isPastorBinaryPath("C:\\src\\pastor\\bin\\pastor")).toBe(true);
    // Near misses: the name alone, a sibling, a different tool.
    expect(isPastorBinaryPath("/usr/local/bin/pastor-helper")).toBe(false);
    expect(isPastorBinaryPath("/opt/pastor/bin/pastor.new")).toBe(false);
    expect(isPastorBinaryPath("/usr/bin/git")).toBe(false);
  });

  test("on win32 the `pastor.exe` that Bun's compiler writes is recognised, on either separator", () => {
    expect(isPastorBinaryPath("C:\\Users\\pat\\.pastor\\versions\\1.2.3\\bin\\pastor.exe", hostFor("win32"))).toBe(true);
    expect(isPastorBinaryPath("C:/src/pastor/bin/pastor.exe", hostFor("win32"))).toBe(true);
    expect(isPastorBinaryPath("C:\\src\\pastor\\bin\\pastor", hostFor("win32"))).toBe(true);
    expect(isPastorBinaryPath("C:\\src\\pastor\\bin\\pastor.exe.bak", hostFor("win32"))).toBe(false);
    // Elsewhere the `.exe` spelling is not a name Pastor publishes.
    expect(isPastorBinaryPath("/opt/pastor/bin/pastor.exe", hostFor("linux"))).toBe(false);
  });

  test("this platform's own binary name is recognised", () => {
    // `pastorBinary` spells `pastor.exe` on Windows; a link to it is a name Pastor published.
    expect(isPastorBinaryPath(pastorBinary("/opt/pastor-v1"))).toBe(true);
  });
});

describe("classifyLink", () => {
  test("nothing there → create", () => {
    expect(classifyLink({ kind: "absent" }, BINARY)).toEqual({ action: "create" });
  });

  test("already ours → keep, so a second `link` is a no-op", () => {
    expect(classifyLink(symlink(BINARY), BINARY)).toEqual({ action: "keep" });
  });

  test("another checkout's binary → replace, naming what it pointed at", () => {
    expect(classifyLink(symlink(OTHER), BINARY)).toEqual({ action: "replace", previous: OTHER });
  });

  test("a foreign symlink → refuse, naming it", () => {
    const v = classifyLink(symlink("/usr/local/bin/some-tool"), BINARY);
    expect(v.action).toBe("refuse");
    expect(v.action === "refuse" && v.reason).toContain("/usr/local/bin/some-tool");
  });

  test("a regular file or a directory → refuse in the words the probe read", () => {
    expect(classifyLink({ kind: "other", what: "a regular file" }, BINARY)).toEqual({
      action: "refuse",
      reason: "a regular file",
    });
    expect(classifyLink({ kind: "other", what: "a directory" }, BINARY)).toEqual({
      action: "refuse",
      reason: "a directory",
    });
  });
});

describe("classifyUnlink", () => {
  test("ours → remove", () => {
    expect(classifyUnlink(symlink(BINARY), BINARY)).toEqual({ action: "remove" });
  });

  test("nothing there → absent, which is not a failure", () => {
    expect(classifyUnlink({ kind: "absent" }, BINARY)).toEqual({ action: "absent" });
  });

  test("another checkout's link → refuse, and say whose it is", () => {
    const v = classifyUnlink(symlink(OTHER), BINARY);
    expect(v.action).toBe("refuse");
    expect(v.action === "refuse" && v.reason).toContain(OTHER);
    expect(v.action === "refuse" && v.reason).toContain("owns the name");
  });

  test("a name Pastor never published → refuse, however it got there", () => {
    expect(classifyUnlink({ kind: "other", what: "a regular file" }, BINARY).action).toBe("refuse");
    expect(classifyUnlink(symlink("/usr/local/bin/some-tool"), BINARY).action).toBe("refuse");
  });
});

describe("onPath", () => {
  test("an exact entry, anywhere in the list", () => {
    expect(onPath(DIR, ["/usr/bin", DIR, "/bin"].join(delimiter))).toBe(true);
    expect(onPath(DIR, DIR)).toBe(true);
  });

  test("a trailing separator on either side still matches", () => {
    expect(onPath(DIR, ["/usr/bin", `${DIR}/`].join(delimiter))).toBe(true);
    expect(onPath(`${DIR}/`, ["/usr/bin", DIR].join(delimiter))).toBe(true);
  });

  test("a prefix is not a match, and neither is an empty or unset PATH", () => {
    expect(onPath(DIR, ["/usr/bin", join(HOME, ".local")].join(delimiter))).toBe(false);
    expect(onPath(DIR, `${DIR}-other`)).toBe(false);
    expect(onPath(DIR, "")).toBe(false);
    expect(onPath(DIR, undefined)).toBe(false);
    // An empty entry means "the current directory" to a shell; it is never our directory.
    expect(onPath(DIR, `${delimiter}${delimiter}`)).toBe(false);
  });
});

describe("pastor link", () => {
  test("creates the link, and says it is a pointer rather than a copy", () => {
    const d = deps();
    expect(cmdLink(d)).toBe(EXIT.OK);
    expect(d.fs.ops).toEqual([`mkdirp ${posixKey(DIR)}`, `symlink ${posixKey(BINARY)} ${posixKey(AT)}`]);
    expect(d.fs.probe(AT)).toEqual({ kind: "symlink", target: BINARY });
    expect(d.io.stdout.join("\n")).toContain(`${AT} → ${BINARY}`);
    expect(d.io.stdout.join("\n")).toContain("not a copy");
  });

  test("refuses to link a checkout that has not been built", () => {
    const d = deps({ built: false });
    expect(cmdLink(d)).toBe(EXIT.FAIL);
    expect(d.fs.ops).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("run the build first");
  });

  test("is idempotent — a second run writes nothing and says so", () => {
    const d = deps({ seed: { [AT]: symlink(BINARY) } });
    expect(cmdLink(d)).toBe(EXIT.OK);
    expect(d.fs.ops).toEqual([]);
    expect(d.io.stdout.join("\n")).toContain("already links");
  });

  test("takes the name over from another checkout, naming what it pointed at", () => {
    const d = deps({ seed: { [AT]: symlink(OTHER) } });
    expect(cmdLink(d)).toBe(EXIT.OK);
    // Remove then create: a symlink cannot be made over an existing name.
    expect(d.fs.ops).toEqual([
      `mkdirp ${posixKey(DIR)}`,
      `rm ${posixKey(AT)}`,
      `symlink ${posixKey(BINARY)} ${posixKey(AT)}`,
    ]);
    expect(d.io.stdout.join("\n")).toContain(OTHER);
    expect(d.io.stdout.join("\n")).toContain("no longer owns the name");
  });

  test("refuses a regular file, a directory and a foreign symlink — and touches none of them", () => {
    for (const there of [
      { kind: "other", what: "a regular file" } as const,
      { kind: "other", what: "a directory" } as const,
      symlink("/usr/local/bin/some-tool"),
    ]) {
      const d = deps({ seed: { [AT]: there } });
      expect(cmdLink(d)).toBe(EXIT.FAIL);
      expect(d.fs.ops).toEqual([]);
      expect(d.fs.probe(AT)).toEqual(there);
      expect(d.io.stderr.join("\n")).toContain("leaving it alone");
    }
  });

  test("warns when the directory is not on PATH — and never edits a profile", () => {
    const d = deps({ path: ["/usr/bin", "/bin"].join(delimiter) });
    expect(cmdLink(d)).toBe(EXIT.OK);
    const out = d.io.stdout.join("\n");
    expect(out).toContain(`${DIR} is not on your PATH`);
    expect(out).toContain("shell profile");
    // The only writes are the link's own.
    expect(d.fs.ops).toEqual([`mkdirp ${posixKey(DIR)}`, `symlink ${posixKey(BINARY)} ${posixKey(AT)}`]);
  });

  test("says nothing about PATH when the directory is already on it", () => {
    const d = deps();
    cmdLink(d);
    expect(d.io.stdout.join("\n")).not.toContain("not on your PATH");
  });

  test("a filesystem that refuses the write is an operational failure, not a crash", () => {
    const d = deps();
    d.fs.readonly.add(AT);
    expect(cmdLink(d)).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("could not link");
  });
});

describe("pastor unlink", () => {
  test("removes our own link, and says the checkout is untouched", () => {
    const d = deps({ seed: { [AT]: symlink(BINARY) } });
    expect(cmdUnlink(d)).toBe(EXIT.OK);
    expect(d.fs.ops).toEqual([`rm ${posixKey(AT)}`]);
    expect(d.fs.probe(AT)).toEqual({ kind: "absent" });
    expect(d.io.stdout.join("\n")).toContain(ROOT);
  });

  test("not linked at all is success, not a failure", () => {
    const d = deps();
    expect(cmdUnlink(d)).toBe(EXIT.OK);
    expect(d.fs.ops).toEqual([]);
    expect(d.io.stdout.join("\n")).toContain("not linked");
  });

  test("refuses another checkout's link — that instance owns it", () => {
    const d = deps({ seed: { [AT]: symlink(OTHER) } });
    expect(cmdUnlink(d)).toBe(EXIT.FAIL);
    expect(d.fs.ops).toEqual([]);
    expect(d.fs.probe(AT)).toEqual(symlink(OTHER));
    expect(d.io.stderr.join("\n")).toContain(OTHER);
    expect(d.io.stderr.join("\n")).toContain("unlink` from there");
  });

  test("refuses whatever else is at the name, and needs no build to say so", () => {
    const d = deps({ built: false, seed: { [AT]: { kind: "other", what: "a regular file" } } });
    expect(cmdUnlink(d)).toBe(EXIT.FAIL);
    expect(d.fs.ops).toEqual([]);
  });
});
