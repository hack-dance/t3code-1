// @effect-diagnostics nodeBuiltinImport:off - Seeds and inspects real launcher files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodePathLayer from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach } from "vite-plus/test";

import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const makeHome = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-shim-refresh-"));
  directories.push(directory);
  return directory;
};

const shimPath = (home: string) => NodePath.join(home, "bin", "t3");

const layerFor = (home: string, isPackaged: boolean) =>
  Layer.mergeAll(
    NodeServices.layer,
    DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/dist-electron",
      homeDirectory: home,
      platform: "darwin",
      processArch: "arm64",
      appVersion: "1.2.3",
      appPath: "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar",
      isPackaged,
      resourcesPath: "/Applications/T3 Code (Nightly).app/Contents/Resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodePathLayer.layerPosix,
          DesktopConfig.layerTest({ T3CODE_HOME: home }),
        ),
      ),
    ),
  );

const writeShim = (home: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(shimPath(home)), { recursive: true });
  NodeFS.writeFileSync(shimPath(home), content, { mode: 0o755 });
};

describe("DesktopCliShim.refreshExisting", () => {
  it.effect("rewrites a launcher the app wrote for an older executable", () => {
    const home = makeHome();
    writeShim(
      home,
      `#!/bin/sh\n# ${DesktopCliShim.MARKER}\nexec '/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)'\n`,
    );
    return DesktopCliShim.refreshExisting.pipe(
      Effect.provide(layerFor(home, true)),
      Effect.map(() => {
        const content = NodeFS.readFileSync(shimPath(home), "utf8");
        assert.include(content, DesktopCliShim.MARKER);
        assert.include(content, process.execPath);
        assert.notInclude(content, "MacOS/T3 Code (Nightly)'");
      }),
    );
  });

  it.effect("does not create a launcher the user never installed", () => {
    const home = makeHome();
    return DesktopCliShim.refreshExisting.pipe(
      Effect.provide(layerFor(home, true)),
      Effect.map(() => {
        assert.isFalse(NodeFS.existsSync(shimPath(home)));
      }),
    );
  });

  it.effect("leaves a launcher the app did not write", () => {
    const home = makeHome();
    const foreign = "#!/bin/sh\nexec /usr/local/bin/t3-real\n";
    writeShim(home, foreign);
    return DesktopCliShim.refreshExisting.pipe(
      Effect.provide(layerFor(home, true)),
      Effect.map(() => {
        assert.equal(NodeFS.readFileSync(shimPath(home), "utf8"), foreign);
      }),
    );
  });

  it.effect("does nothing in unpackaged runs", () => {
    const home = makeHome();
    const stale = `#!/bin/sh\n# ${DesktopCliShim.MARKER}\nexec /old/path\n`;
    writeShim(home, stale);
    return DesktopCliShim.refreshExisting.pipe(
      Effect.provide(layerFor(home, false)),
      Effect.map(() => {
        assert.equal(NodeFS.readFileSync(shimPath(home), "utf8"), stale);
      }),
    );
  });
});
