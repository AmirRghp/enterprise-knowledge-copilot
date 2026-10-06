/**
 * Restore CSS and SVG data URLs compressed by scripts/prebuilt/build.mjs.
 * Inline charts ship their shared editor, styles, and icons in one self-contained
 * fragment with a 1 MB limit. Lossless DEFLATE keeps the real dashboard controls
 * within that budget without network requests or a second set of inline styles.
 * Returns a promise of resource text, never executable code. The mount waits for
 * it before rendering; malformed resources reject into the load-error state.
 */
export function decodeBundledResource(encoded) {
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
}
