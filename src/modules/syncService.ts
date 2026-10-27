import { getPref } from "../utils/prefs";
import { buildDocument } from "./documentBuilder";
import {
  FeishuClient,
  FeishuError,
  type CreatedDocument,
} from "./feishuClient";
import { OAuthService } from "./oauthService";
import { StateStore } from "./stateStore";
import { BitableSyncService } from "./bitableSync";
import type {
  DocumentModel,
  DocumentSection,
  DocumentSnapshot,
  DocumentWriteResult,
  FeishuUser,
  SyncRecord,
  SyncResult,
  SyncedSection,
} from "./types";

export type ProgressCallback = (
  completed: number,
  total: number,
  result: SyncResult,
) => void;

export interface SyncStateRepository {
  get(libraryID: number, itemKey: string): Promise<SyncRecord | undefined>;
  set(record: SyncRecord): Promise<void>;
  delete(libraryID: number, itemKey: string): Promise<void>;
}

export interface SyncClient {
  getCurrentUser(): Promise<FeishuUser>;
  testConnection(folderToken: string): Promise<void>;
  createDocument(title: string, folderToken: string): Promise<CreatedDocument>;
  inspectDocument(documentId: string): Promise<DocumentSnapshot | undefined>;
  updateDocumentTitle(documentId: string, title: string): Promise<void>;
  syncDocumentSections(
    documentId: string,
    sections: DocumentSection[],
    previous: SyncedSection[] | undefined,
    resolveAttachment: (attachmentKey: string) => Promise<string>,
    checkpoint: (sections: SyncedSection[]) => Promise<void>,
    initialSnapshot?: DocumentSnapshot,
  ): Promise<DocumentWriteResult>;
  deleteDocument(documentId: string): Promise<void>;
}

export interface SyncServiceDependencies {
  oauth?: OAuthService;
  state?: SyncStateRepository;
  client?: SyncClient;
  buildDocument?: (item: Zotero.Item) => Promise<DocumentModel>;
}

export class SyncService {
  readonly oauth: OAuthService;
  readonly state: SyncStateRepository;
  readonly client: SyncClient;
  private readonly documentBuilder: (
    item: Zotero.Item,
  ) => Promise<DocumentModel>;
  private readonly itemOperations = new Map<string, Promise<void>>();
  private readonly bitable: BitableSyncService;
  private stopped = false;

  constructor(dependencies: SyncServiceDependencies = {}) {
    this.oauth = dependencies.oauth || new OAuthService();
    this.state = dependencies.state || new StateStore();
    this.client = dependencies.client || new FeishuClient(this.oauth);
    this.bitable = new BitableSyncService(this.oauth);
    this.documentBuilder = dependencies.buildDocument || buildDocument;
  }

  unregister(): void {
    this.stopped = true;
    this.oauth.dispose();
  }

  async syncItems(
    input: Zotero.Item[],
    onProgress?: ProgressCallback,
    shouldContinue: () => boolean = () => true,
  ): Promise<SyncResult[]> {
    const configuration = this.configuration();
    const items = uniqueRegularUserItems(input);
    const results: SyncResult[] = [];
    for (const item of items) {
      if (!shouldContinue()) throw new Error("自动同步已关闭，已停止剩余文献");
      this.assertConfiguration(configuration);
      const result = await this.syncItem(item, configuration, shouldContinue);
      results.push(result);
      onProgress?.(results.length, items.length, result);
    }
    return results;
  }

  async syncItem(
    item: Zotero.Item,
    configuration = this.configuration(),
    shouldContinue: () => boolean = () => true,
  ): Promise<SyncResult> {
    const topLevelItem = resolveTopLevelItem(item);
    return this.withItemOperation(topLevelItem, () => {
      this.assertConfiguration(configuration);
      const assertCurrent = () => {
        this.assertConfiguration(configuration);
        if (!shouldContinue())
          throw new Error("自动同步已关闭，已停止剩余文献");
      };
      assertCurrent();
      return getPref("targetBase")
        ? this.bitable.syncItem(topLevelItem, assertCurrent)
        : this.performSyncItem(topLevelItem);
    });
  }

  private configuration(): string {
    return JSON.stringify([
      getPref("targetBase"),
      getPref("targetTable"),
      getPref("targetFolder"),
      getPref("syncPDF"),
    ]);
  }

  private assertConfiguration(expected: string): void {
    if (this.stopped) throw new Error("插件已关闭，已停止同步");
    if (this.configuration() !== expected)
      throw new Error("同步位置已改变，已停止原批次，请重新同步");
  }

  private async performSyncItem(item: Zotero.Item): Promise<SyncResult> {
    const title = String(item.getField("title") || "Untitled");
    const base: SyncResult = {
      libraryID: item.libraryID,
      itemKey: item.key,
      title,
      outcome: "failed",
      errors: [],
    };
    try {
      assertSupportedItem(item);
      const folder = configuredFolder();
      const model = await this.documentBuilder(item);
      let record = await this.state.get(item.libraryID, item.key);
      let snapshot = record
        ? await this.client.inspectDocument(record.documentId)
        : undefined;
      if (record && !snapshot) record = undefined;

      let created = false;
      if (!record) {
        const document = await this.client.createDocument(model.title, folder);
        created = true;
        record = {
          libraryID: item.libraryID,
          itemKey: item.key,
          documentId: document.documentId,
          documentUrl: document.documentUrl,
          documentTitle: model.title,
          sourceHash: "",
          lastSyncedAt: "",
        };
        await this.state.set(record);
        snapshot = await this.client.inspectDocument(record.documentId);
        if (!snapshot) {
          throw new Error("Feishu did not return the created document");
        }
      }

      const previousSourceHash = record.sourceHash;
      const wasPending = Boolean(record.pendingSync);
      record.pendingSync =
        record.pendingSync?.targetSourceHash === model.sourceHash
          ? record.pendingSync
          : {
              targetSourceHash: model.sourceHash,
              startedAt: new Date().toISOString(),
            };
      await this.state.set(record);

      let titleChanged = false;
      if (snapshot!.title !== model.title) {
        await this.client.updateDocumentTitle(record.documentId, model.title);
        titleChanged = true;
      }
      record.documentTitle = model.title;
      await this.state.set(record);

      const write = await this.client.syncDocumentSections(
        record.documentId,
        model.sections,
        record.sections,
        (key) => resolveAttachment(item.libraryID, key),
        async (sections) => {
          record.sections = sections;
          await this.state.set(record);
        },
        snapshot,
      );
      record.sections = write.sections;
      record.sourceHash = write.errors.length ? "" : model.sourceHash;
      record.lastSyncedAt = new Date().toISOString();
      if (!write.errors.length) delete record.pendingSync;
      await this.state.set(record);
      return {
        ...base,
        outcome: write.errors.length
          ? "partial"
          : created
            ? "created"
            : write.changed ||
                titleChanged ||
                previousSourceHash !== model.sourceHash ||
                wasPending
              ? "updated"
              : "unchanged",
        documentUrl: record.documentUrl,
        errors: write.errors,
      };
    } catch (error) {
      ztoolkit.log("Feishu sync failed", item.key, error);
      return { ...base, errors: [errorMessage(error)] };
    }
  }

  async deleteItem(item: Zotero.Item): Promise<boolean> {
    if (getPref("targetBase")) {
      throw new Error("请在飞书表格中手动删除记录；插件不会自动删除阅读笔记。");
    }
    const topLevelItem = resolveTopLevelItem(item);
    return this.withItemOperation(topLevelItem, () =>
      this.performDeleteItem(topLevelItem),
    );
  }

  private async performDeleteItem(item: Zotero.Item): Promise<boolean> {
    const record = await this.state.get(item.libraryID, item.key);
    if (!record) return false;
    try {
      await this.client.deleteDocument(record.documentId);
    } catch (error) {
      if (!(error instanceof FeishuError && error.status === 404)) throw error;
    }
    await this.state.delete(item.libraryID, item.key);
    return true;
  }

  private async withItemOperation<T>(
    item: Zotero.Item,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${item.libraryID}:${item.key}`;
    const previous = this.itemOperations.get(key) || Promise.resolve();
    const current = previous.then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.itemOperations.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.itemOperations.get(key) === tail) {
        this.itemOperations.delete(key);
      }
    }
  }

  async openItem(item: Zotero.Item): Promise<boolean> {
    const topLevelItem = resolveTopLevelItem(item);
    if (getPref("targetBase")) return this.bitable.openItem(topLevelItem);
    const record = await this.state.get(
      topLevelItem.libraryID,
      topLevelItem.key,
    );
    if (!record) return false;
    Zotero.launchURL(record.documentUrl);
    return true;
  }

  async testConnection(): Promise<void> {
    if (getPref("targetBase")) return this.bitable.testConnection();
    await this.client.testConnection(configuredFolder());
  }

  async getCurrentUser(): Promise<FeishuUser> {
    return this.client.getCurrentUser();
  }
}

export function uniqueRegularUserItems(items: Zotero.Item[]): Zotero.Item[] {
  const userLibraryID = Zotero.Libraries.userLibraryID;
  const seen = new Set<string>();
  const resolved: Zotero.Item[] = [];
  items.forEach((selectedItem) => {
    const item = resolveTopLevelItem(selectedItem);
    if (!item.isRegularItem() || item.libraryID !== userLibraryID) return false;
    const key = `${item.libraryID}:${item.key}`;
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push(item);
  });
  return resolved;
}

function resolveTopLevelItem(item: Zotero.Item): Zotero.Item {
  return item.topLevelItem || item;
}

function assertSupportedItem(item: Zotero.Item): void {
  if (!item.isRegularItem())
    throw new Error("Only regular Zotero items can sync");
  if (item.libraryID !== Zotero.Libraries.userLibraryID) {
    throw new Error("Group libraries are not supported in this version");
  }
}

function configuredFolder(): string {
  return String(getPref("targetFolder") || "").trim();
}

async function resolveAttachment(
  libraryID: number,
  attachmentKey: string,
): Promise<string> {
  if (!attachmentKey)
    throw new Error("Zotero attachment has no attachment key");
  const attachment = Zotero.Items.getByLibraryAndKey(libraryID, attachmentKey);
  if (!attachment || !attachment.isAttachment()) {
    throw new Error(`Zotero attachment ${attachmentKey} was not found`);
  }
  const path = await attachment.getFilePathAsync();
  if (!path)
    throw new Error(`Zotero attachment ${attachmentKey} is unavailable`);
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
