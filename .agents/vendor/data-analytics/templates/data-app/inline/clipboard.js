/** Native selection copy also works in hosts that disallow the async Clipboard API. */
export function copySelection(content, trigger) {
  const document = trigger.ownerDocument;
  const selection = document.getSelection();
  const ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange());
  const target = document.createElement("div");
  target.contentEditable = "true";
  target.style.cssText = "position:fixed;left:-10000px;top:0;white-space:pre";
  target.append(content);
  document.body.append(target);
  try {
    target.focus();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand("copy")) throw new Error("Copy is unavailable in this view.");
  } finally {
    target.remove();
    selection.removeAllRanges();
    for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range);
    trigger.focus({ preventScroll: true });
  }
}

export async function imageForClipboard(blob) {
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

export async function copyPng(png, trigger) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch { copySelection(await imageForClipboard(await png), trigger); }
}
