/**
 * Options every Pele render in T3 uses. Diagrams can come from untrusted
 * text, so they never emit links or load images. Fleet renderers
 * (pele-render, the KB build) use the same pair.
 */
export const PELE_SAFE_OPTIONS = { links: false, images: false } as const;
