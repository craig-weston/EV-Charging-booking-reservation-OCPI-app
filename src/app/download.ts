// Offers a generated file (for example a data export) to the person using the app.
// In a normal browser this is an ordinary download. When the app runs inside the claude.ai
// artifact viewer (the demo), pages can't download directly, so the viewer's "downloads"
// capability is used instead: it asks the person to confirm the save.

interface ViewerDownloads {
  save(request: { filename: string; data: string | Blob }): Promise<{ status: "saved" | "delivered" }>;
}

interface ViewerHost {
  use?(name: string): Promise<unknown>;
}

/** Resolves "saved", or "declined" when the person turns the save down in the viewer. */
export async function saveFile(filename: string, data: string, type = "application/json"): Promise<"saved" | "declined"> {
  const host = (window as unknown as { claude?: ViewerHost }).claude;
  if (typeof host?.use === "function") {
    const downloads = (await host.use("downloads").catch(() => null)) as ViewerDownloads | null;
    if (downloads) {
      try {
        await downloads.save({ filename, data });
        return "saved";
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "declined") return "declined";
        if (code === "rate_limited") throw new Error("A save is already waiting for your answer");
        // Any other refusal: fall back to an ordinary download below.
      }
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return "saved";
}
