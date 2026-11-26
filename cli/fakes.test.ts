import { describe, expect, test } from "bun:test";

import { hostFor } from "../bridge/host.ts";
import { fakeFiles, posixKey } from "./fakes.ts";

describe("posixKey", () => {
  test("folds a Windows path to the POSIX key a fake filesystem stores", () => {
    expect(posixKey("C:\\opt\\pastor\\bin\\pastor.exe", hostFor("win32"))).toBe("/opt/pastor/bin/pastor.exe");
    expect(posixKey("\\opt\\pastor", hostFor("win32"))).toBe("/opt/pastor");
  });

  test("without a host it folds, so a Windows host pinned on Linux still finds its files", () => {
    expect(posixKey("C:\\opt\\pastor")).toBe("/opt/pastor");
    expect(posixKey("/opt/pastor")).toBe("/opt/pastor");
  });

  test("leaves a path alone off Windows, where a backslash is a legal name character", () => {
    expect(posixKey("/opt/co\\llie", hostFor("linux"))).toBe("/opt/co\\llie");
  });
});

describe("fakeFiles", () => {
  test("answers a path seeded by its POSIX key", () => {
    const files = fakeFiles({ "/opt/pastor/VERSION": "1.0.0\n" });
    expect(files.read("/opt/pastor/VERSION")).toBe("1.0.0\n");
    expect(files.exists("/opt/pastor")).toBe(true);
  });
});
