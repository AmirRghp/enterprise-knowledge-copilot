/** Keep embedded asset fragments unambiguous in HTML, JavaScript, and CSS URLs. */
export function encodeDataAssetFragment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
