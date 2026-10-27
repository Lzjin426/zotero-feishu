import { getPref } from "../utils/prefs";
import { uniqueRegularUserItems } from "./syncService";

/** Coalesce edits, then serialize them through the normal sync service. */
export class AutoSyncService {
  private observerID?: string;
  private timer?: number;
  private pending = new Set<number>();
  private entireLibrary = false;
  private running = false;
  private alive = false;
  private collections = new Set<number>();

  register(): void {
    if (this.alive) return;
    this.alive = true;
    this.collections = new Set(
      Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true).map(
        (c) => c.id,
      ),
    );
    this.observerID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids) => {
          let relevantCollection = false;
          if (type === "collection") {
            const current = Zotero.Collections.getByLibrary(
              Zotero.Libraries.userLibraryID,
              true,
            );
            relevantCollection = ids.some(
              (id) =>
                this.collections.has(Number(id)) ||
                current.some((c) => c.id === Number(id)),
            );
            this.collections = new Set(current.map((c) => c.id));
          }
          if (!this.enabled()) return;
          if (type === "item") {
            if (["delete", "trash"].includes(event)) return;
            for (const id of ids) this.pending.add(Number(id));
          } else if (type === "item-tag" || type === "collection-item") {
            for (const id of ids) {
              const parts = String(id).split("-");
              const itemID = Number(parts[type === "item-tag" ? 0 : 1]);
              if (Number.isSafeInteger(itemID) && itemID > 0)
                this.pending.add(itemID);
            }
          } else if (type === "collection") {
            if (!relevantCollection) return;
            this.entireLibrary = true;
          }
          this.schedule();
        },
      },
      ["item", "collection", "collection-item", "item-tag"],
      "zotero-feishu-auto-sync",
    );
    if (this.enabled()) {
      this.entireLibrary = true;
      this.schedule();
    }
  }

  unregister(): void {
    this.alive = false;
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    this.observerID = undefined;
    if (this.timer !== undefined) {
      Zotero.getMainWindow().clearTimeout(this.timer);
    }
    this.timer = undefined;
    this.pending.clear();
    this.entireLibrary = false;
  }

  private enabled(): boolean {
    return Boolean(
      this.alive &&
      getPref("autoSync") &&
      getPref("targetBase") &&
      getPref("targetTable") &&
      addon.sync.oauth.isAuthorized(),
    );
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      Zotero.getMainWindow().clearTimeout(this.timer);
    }
    this.timer = Zotero.getMainWindow().setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 2000);
  }

  private async flush(): Promise<void> {
    if (!this.enabled() || this.running) return;
    this.running = true;
    try {
      const full = this.entireLibrary;
      const ids = [...this.pending];
      this.pending.clear();
      this.entireLibrary = false;
      const items = full
        ? await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false)
        : await Zotero.Items.getAsync(ids);
      const regular = uniqueRegularUserItems(items).filter(
        (item) => !item.deleted,
      );
      addon.syncStatus.markSyncing(regular);
      await addon.sync.syncItems(
        regular,
        (_completed, _total, result) => addon.syncStatus.markResult(result),
        () => this.enabled(),
      );
    } catch (error) {
      ztoolkit.log("Automatic Feishu synchronization failed", error);
    } finally {
      this.running = false;
      if (this.enabled() && (this.pending.size || this.entireLibrary)) {
        this.schedule();
      }
    }
  }
}
