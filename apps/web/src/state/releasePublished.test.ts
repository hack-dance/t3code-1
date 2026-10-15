import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { releasePublishedAtom } from "./releasePublished";

const version = "0.0.46-nightly.20261012.3021";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

async function settledCheck() {
  const atom = releasePublishedAtom(version);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

describe("releasePublishedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("checks the HD GitHub release without credentials or tracing headers", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ tag_name: `v${version}`, draft: false, assets: [{ name: "SHA256SUMS" }] }),
    );

    const result = await settledCheck();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(
      `https://api.github.com/repos/hack-dance/t3code-1/releases/tags/v${version}`,
    );
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
    expect(AsyncResult.getOrElse(result, () => false)).toBe(true);
  });

  it("reports a missing HD release as unpublished", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));

    const result = await settledCheck();

    expect(AsyncResult.isSuccess(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => true)).toBe(false);
  });

  it("does not offer a draft, another version, or a release missing checksums", async () => {
    for (const body of [
      { tag_name: `v${version}`, draft: true, assets: [{ name: "SHA256SUMS" }] },
      { tag_name: "v0.0.1", draft: false, assets: [{ name: "SHA256SUMS" }] },
      { tag_name: `v${version}`, draft: false, assets: [] },
    ]) {
      fetchMock.mockImplementation(async () => Response.json(body));
      const result = await settledCheck();
      expect(AsyncResult.getOrElse(result, () => true)).toBe(false);
    }
  });

  it("leaves a failed first check unknown, which callers read as unpublished", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await settledCheck();

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });
});
