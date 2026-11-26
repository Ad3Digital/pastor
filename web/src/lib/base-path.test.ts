import { basePath, mounted, resetBasePathForTests } from "./base-path";

// ADR 0052: the mount is read from the document the bridge served, not from a build constant.
function setMount(content: string | null) {
  document.querySelector('meta[name="pastor-base"]')?.remove();
  if (content !== null) {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "pastor-base");
    meta.setAttribute("content", content);
    document.head.appendChild(meta);
  }
  resetBasePathForTests();
}

afterEach(() => setMount(null));

describe("basePath — where this document is mounted", () => {
  it("is the root with no meta tag, as the dev server and every test serve it", () => {
    setMount(null);
    expect(basePath()).toBe("/");
    expect(mounted("/api/snapshot")).toBe("/api/snapshot");
  });

  it("is the root when the bridge wrote a root", () => {
    setMount("/");
    expect(basePath()).toBe("/");
  });

  it("reads the mount the bridge wrote, and puts it in front of a root-absolute path", () => {
    setMount("/pastor/");
    expect(basePath()).toBe("/pastor/");
    expect(mounted("/api/snapshot")).toBe("/pastor/api/snapshot");
    expect(mounted("/sw.js")).toBe("/pastor/sw.js");
    expect(mounted("/")).toBe("/pastor/");
  });

  it("normalises a tag written without its slashes to the shape the bridge produces", () => {
    setMount("pastor");
    expect(basePath()).toBe("/pastor/");
  });

  it("leaves a full URL and a relative path alone", () => {
    setMount("/pastor/");
    expect(mounted("https://example.com/x")).toBe("https://example.com/x");
    expect(mounted("sw.js")).toBe("sw.js");
    expect(mounted("")).toBe("");
  });

  it("is read once: a tag that changes after the first read is not seen", () => {
    setMount("/a/");
    expect(basePath()).toBe("/a/");
    document.querySelector('meta[name="pastor-base"]')?.setAttribute("content", "/b/");
    expect(basePath()).toBe("/a/");
  });
});
