/**
 * Hack Dance fork branding.
 *
 * User-visible product name for every HD build. Identity that existing installs
 * depend on is deliberately unchanged: the bundle ID, package names, the
 * `t3code` URL schemes, state directories, and the Electron runtime name
 * (which keys desktop safe storage and the User-Agent product token).
 *
 * `productName` in apps/desktop/package.json is intentionally left as upstream
 * has it: packaging takes its name from resolveDesktopProductName in
 * scripts/build-desktop-artifact.ts, and leaving the file alone keeps merges
 * from upstream clean.
 */
export const HD_PRODUCT_NAME = "Hack the Planet";

/**
 * Electron runtime name base. Must stay "T3 Code": Electron derives the macOS
 * Keychain "<name> Safe Storage" entry and the Linux secret-store product
 * name from it, so renaming it would orphan encrypted credentials stored by
 * earlier builds.
 */
export const HD_ELECTRON_RUNTIME_BASE_NAME = "T3 Code";
