import { render } from "pele";
import { describe, expect, it } from "vite-plus/test";

import { PELE_SAFE_OPTIONS } from "./peleOptions";

const FLOWCHART = `flowchart LR
  A[Agent] -->|reads| B{Sidecar}
  B -->|primary| C[Extension]
  B -.->|fallback| D[cua-driver]
  I@{ img: "https://example.com/track.png", label: "Remote", pos: "t" }
  C --> I
  click A "https://example.com/phish" "tooltip"
`;

describe("pele render", () => {
  it("renders a flowchart to a stable SVG", async () => {
    const { svg } = render(FLOWCHART, PELE_SAFE_OPTIONS);
    expect(svg.startsWith("<svg")).toBe(true);
    await expect(svg).toMatchFileSnapshot("./__snapshots__/peleRender.flowchart.svg");
  });

  it("never emits links or remote images", () => {
    const { svg } = render(FLOWCHART, PELE_SAFE_OPTIONS);
    expect(svg).not.toMatch(/<a[\s>]|href=|<image[\s>]|example\.com/);
  });

  it("throws a readable error for invalid source", () => {
    expect(() => render("flowchart LR\n  A -->", PELE_SAFE_OPTIONS)).toThrow();
  });
});
