// Hands a text file to the browser's own save flow. The content goes into a Blob URL that is revoked straight after the click, and nowhere else: it is never written to the page, the console or storage.

/** Saves `text` as a download named `filename`. */
export function saveTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
