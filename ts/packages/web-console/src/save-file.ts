// Hands a text file to the browser's own save flow. The content goes into a Blob URL that lives only as long as the browser needs to start the download, and nowhere else: it is never written to the page, the console or storage.

/** How long the Blob URL is kept after the click. Safari and some Firefox builds read the blob after the click returns, so revoking at once can cancel the download; a minute is far longer than starting a download takes and short enough not to hold the content for the life of the page. */
const REVOKE_DELAY_MS = 60_000;

/** Saves `text` as a download named `filename`. The link is attached to the document while it is clicked, since some browsers ignore a click on a detached anchor. */
export function saveTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}
