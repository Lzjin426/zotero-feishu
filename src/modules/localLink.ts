const PATH = "/zotero-feishu/open";

/** A browser navigation can select an item; it never reads or edits library data. */
export class OpenItemEndpoint {
  supportedMethods = ["GET"];
  supportedDataTypes = ["*"];
  allowRequestsFromUnsafeWebContent = true;

  async init(options: {
    searchParams: URLSearchParams;
    headers: Record<string, string>;
  }): Promise<[number, string, string]> {
    if (
      options.headers["sec-fetch-mode"] !== "navigate" ||
      options.headers["sec-fetch-dest"] !== "document" ||
      options.headers["sec-fetch-user"] !== "?1"
    )
      return [403, "text/plain", "Open this link directly in your browser."];
    const key = options.searchParams.get("itemKey") || "";
    if (!/^[A-Z0-9]{8}$/.test(key))
      return [400, "text/plain", "Invalid item key."];
    const item = Zotero.Items.getByLibraryAndKey(
      Zotero.Libraries.userLibraryID,
      key,
    );
    if (!item || item.deleted || !item.isRegularItem())
      return [404, "text/plain", "Item not found."];
    const win = Zotero.getMainWindow();
    await win.ZoteroPane.selectItem(item.id);
    win.focus();
    return [
      200,
      "text/html; charset=utf-8",
      '<!doctype html><meta charset="utf-8"><title>Zotero</title><p>已在 Zotero 中选中文献，可以关闭此页。</p>',
    ];
  }
}

export function registerLocalLink(): void {
  (Zotero.Server as any).Endpoints[PATH] = OpenItemEndpoint;
}

export function unregisterLocalLink(): void {
  const endpoints = (Zotero.Server as any).Endpoints;
  if (endpoints[PATH] === OpenItemEndpoint) delete endpoints[PATH];
}

export function localItemLink(key: string): { text: string; link: string } {
  const configured = Number(Zotero.Prefs.get("httpServer.port")) || 23119;
  const port =
    Number.isInteger(configured) && configured > 0 && configured <= 65535
      ? configured
      : 23119;
  return {
    text: "在本机 Zotero 中打开",
    link: `http://127.0.0.1:${port}${PATH}?itemKey=${encodeURIComponent(key)}`,
  };
}
