import { getPref } from "../utils/prefs";
import { FeishuError, FeishuTransport } from "./feishu/transport";
import { OAuthService } from "./oauthService";
import type { SyncResult } from "./types";
import { localItemLink } from "./localLink";

type Json = Record<string, any>;
interface Field {
  field_name: string;
  type: number;
}
interface RemoteRecord {
  record_id: string;
  fields: Json;
}
export interface BitablePdf {
  key: string;
  name: string;
  path: string;
  size: number;
  fingerprint: string;
}
export interface BitableState {
  version: 1;
  records: Record<string, string>;
  uploads: Record<string, string>;
  pendingCreates: Record<string, string>;
}
export interface BitableSyncDependencies {
  transport: Pick<FeishuTransport, "request" | "mediaRequest">;
  preference(name: "targetBase" | "targetTable" | "syncPDF"): unknown;
  readState(): Promise<BitableState>;
  writeState(state: BitableState): Promise<void>;
  pdfs(item: Zotero.Item): Promise<BitablePdf[]>;
  readBytes(
    path: string,
    offset?: number,
    maxBytes?: number,
  ): Promise<Uint8Array>;
  now(): number;
  uuid(): string;
  launch(url: string): void;
}

const SOURCE_TYPES: Record<string, number[]> = {
  文献标题: [1],
  作者: [1],
  年份: [1, 2],
  期刊或会议: [1],
  摘要: [1],
  DOI: [15],
  原文链接: [15],
  "Zotero 条目链接": [15],
  "Zotero 分类": [1],
  "Zotero 标签": [1],
  "Zotero 唯一标识": [1],
  最近同步时间: [5],
};
const UNIQUE = "Zotero 唯一标识";
const UPLOAD_LIMIT = 20 * 1024 * 1024;

/** Serializes complete read/modify/write operations across service instances. */
export class BitableSyncService {
  private static queue: Promise<void> = Promise.resolve();
  private readonly deps: BitableSyncDependencies;

  constructor(
    oauth: OAuthService,
    dependencies: Partial<BitableSyncDependencies> = {},
  ) {
    this.deps = {
      transport: new FeishuTransport(oauth),
      preference: (name) => getPref(name as Parameters<typeof getPref>[0]),
      readState,
      writeState,
      pdfs: localPdfs,
      readBytes: (path, offset = 0, maxBytes) =>
        io().read(path, {
          offset,
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }),
      now: () => Date.now(),
      uuid: () => (Zotero.getMainWindow() as any).crypto.randomUUID(),
      launch: (url) => Zotero.launchURL(url),
      ...dependencies,
    };
  }

  async syncItem(
    input: Zotero.Item,
    assertCurrent: () => void = () => undefined,
  ): Promise<SyncResult> {
    const item = topLevel(input);
    const result: SyncResult = {
      libraryID: item.libraryID,
      itemKey: item.key,
      title: field(item, "title"),
      outcome: "failed",
      errors: [],
    };
    try {
      return await this.exclusive(async () => {
        assertCurrent();
        if (!item.isRegularItem()) throw new Error("只能同步文献条目");
        const target = this.target();
        const schema = await this.schema(target.path);
        const key = `${item.libraryID}:${item.key}`;
        const stateKey = `${target.base}:${target.table}:${key}`;
        const state = await this.deps.readState();
        let remote = await this.find(target.path, key);
        const fields = sourceFields(
          item,
          schema.some((f) => f.field_name === "分类"),
        );
        if (schema.find((f) => f.field_name === "年份")?.type === 2) {
          fields.年份 = fields.年份 ? Number(fields.年份) : null;
        }
        if (this.deps.preference("syncPDF") === true) {
          const pdfs = await this.deps.pdfs(item);
          if (pdfs.length) {
            const attachments = schema.filter((f) => f.type === 17);
            const preferred = attachments.filter((f) =>
              /^(PDF|PDF 附件|附件)$/i.test(f.field_name),
            );
            const attachmentField =
              preferred.length === 1
                ? preferred[0]
                : attachments.length === 1
                  ? attachments[0]
                  : undefined;
            if (!attachmentField) throw new Error("无法唯一确定 PDF 附件字段");
            const tokens = new Set<string>();
            for (const pdf of pdfs) {
              // Scope by Base; uploaded files cannot be reused in another Base.
              const uploadKey = `${target.base}:${item.libraryID}:${pdf.key}:${pdf.fingerprint}`;
              let token = state.uploads[uploadKey];
              if (!token) {
                token = await this.upload(target.base, pdf);
                state.uploads[uploadKey] = token;
                await this.deps.writeState(state);
              }
              tokens.add(token);
            }
            // An upload can take minutes. Re-read just before writing so files
            // added by the reader during the upload are included in the union.
            const latest = await this.find(target.path, key);
            if (remote && latest?.record_id !== remote.record_id)
              throw new Error("上传期间远程记录发生变化，请重新同步");
            remote = latest;
            const existing = remote?.fields[attachmentField.field_name];
            if (existing != null && !Array.isArray(existing))
              throw new Error("飞书附件格式无效");
            const merged = new Set<string>();
            for (const attachment of existing || []) {
              if (!attachment.file_token)
                throw new Error(
                  "飞书附件缺少 file_token，已停止以避免丢失附件",
                );
              merged.add(attachment.file_token);
            }
            const needsAttachmentWrite = Array.from(tokens).some(
              (token) => !merged.has(token),
            );
            if (needsAttachmentWrite) {
              for (const token of tokens) merged.add(token);
              fields[attachmentField.field_name] = Array.from(
                merged,
                (file_token) => ({ file_token }),
              );
            }
          }
        }
        fields.最近同步时间 = this.deps.now();
        let recordID: string;
        if (remote) {
          const response = await this.request(
            "PUT",
            `${target.path}/records/${encodeURIComponent(remote.record_id)}`,
            { fields },
          );
          recordID = requireRecord(response).record_id;
          if (recordID !== remote.record_id)
            throw new Error("飞书返回了不匹配的记录 ID");
        } else {
          state.pendingCreates[stateKey] ||= this.deps.uuid();
          await this.deps.writeState(state);
          const response = await this.request(
            "POST",
            `${target.path}/records?client_token=${encodeURIComponent(state.pendingCreates[stateKey])}`,
            { fields },
          );
          recordID = requireRecord(response).record_id;
        }
        state.records[stateKey] = recordID;
        delete state.pendingCreates[stateKey];
        await this.deps.writeState(state);
        return {
          ...result,
          outcome: remote ? "updated" : "created",
          documentUrl: target.url(recordID),
        };
      });
    } catch (error) {
      return {
        ...result,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  async openItem(input: Zotero.Item): Promise<boolean> {
    return this.exclusive(async () => {
      const item = topLevel(input);
      const target = this.target();
      const record = await this.find(
        target.path,
        `${item.libraryID}:${item.key}`,
      );
      if (!record) return false;
      this.deps.launch(target.url(record.record_id));
      return true;
    });
  }

  async testConnection(): Promise<void> {
    await this.exclusive(async () => {
      const target = this.target();
      await this.schema(target.path);
      // Verify record-read access too, without writing a probe record.
      await this.find(target.path, "__zotero_feishu_connection_probe__");
    });
  }

  private target() {
    const raw = String(this.deps.preference("targetBase") || "").trim();
    let base = raw;
    let origin = "https://www.feishu.cn";
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      if (
        url.protocol !== "https:" ||
        !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname)
      )
        throw new Error("请填写有效的飞书 Base 链接");
      base = url.pathname.match(/^\/base\/([a-zA-Z0-9]+)\/?$/)?.[1] || "";
      origin = url.origin;
    }
    const table = String(this.deps.preference("targetTable") || "").trim();
    if (!/^[a-zA-Z0-9]+$/.test(base) || !/^tbl[a-zA-Z0-9]+$/.test(table))
      throw new Error("请配置 Base token（或 /base/ 链接）及 table ID");
    return {
      base,
      table,
      path: `/bitable/v1/apps/${base}/tables/${table}`,
      url: (record: string) =>
        `${origin}/base/${base}?table=${table}&record=${encodeURIComponent(record)}`,
    };
  }

  private async schema(path: string): Promise<Field[]> {
    const fields: Field[] = [];
    let page = "";
    const seen = new Set<string>();
    do {
      const response = await this.request(
        "GET",
        `${path}/fields?page_size=100${page ? `&page_token=${encodeURIComponent(page)}` : ""}`,
      );
      if (!Array.isArray(response.items)) throw new Error("飞书未返回字段列表");
      fields.push(...response.items);
      page = nextPage(response, seen);
    } while (page);
    for (const [name, types] of Object.entries(SOURCE_TYPES)) {
      const matches = fields.filter((f) => f.field_name === name);
      if (matches.length !== 1 || !types.includes(matches[0].type))
        throw new Error(`飞书字段缺失或类型不符：${name}`);
    }
    const classification = fields.filter((f) => f.field_name === "分类");
    if (
      classification.length > 1 ||
      (classification.length === 1 && classification[0].type !== 4)
    )
      throw new Error("飞书字段类型不符：分类（应为多选）");
    return fields;
  }

  private async find(
    path: string,
    key: string,
  ): Promise<RemoteRecord | undefined> {
    const records: RemoteRecord[] = [];
    const seen = new Set<string>();
    let page = "";
    do {
      const response = await this.request(
        "POST",
        `${path}/records/search?page_size=500${page ? `&page_token=${encodeURIComponent(page)}` : ""}`,
        {
          filter: {
            conjunction: "and",
            conditions: [{ field_name: UNIQUE, operator: "is", value: [key] }],
          },
        },
      );
      if (!Array.isArray(response.items)) throw new Error("飞书未返回记录列表");
      for (const record of response.items) {
        if (
          !record.record_id ||
          !record.fields ||
          text(record.fields[UNIQUE]) !== key
        )
          throw new Error("飞书返回了不匹配的唯一标识");
        records.push(record);
      }
      page = nextPage(response, seen);
    } while (page);
    if (records.length > 1)
      throw new Error(`唯一标识 ${key} 对应多条记录，请先消除重复`);
    return records[0];
  }

  private async upload(base: string, pdf: BitablePdf): Promise<string> {
    if (!Number.isSafeInteger(pdf.size) || pdf.size <= 0)
      throw new Error(`PDF 为空或大小无效：${pdf.name}`);
    const win = Zotero.getMainWindow() as any;
    let response: Json;
    if (pdf.size <= UPLOAD_LIMIT) {
      const bytes = await this.deps.readBytes(pdf.path);
      if (bytes.byteLength !== pdf.size)
        throw new Error(`PDF 在读取时发生变化：${pdf.name}`);
      const form = new win.FormData();
      form.append("file_name", pdf.name);
      form.append("parent_type", "bitable_file");
      form.append("parent_node", base);
      form.append("size", String(pdf.size));
      form.append(
        "file",
        new win.Blob([bytes], { type: "application/pdf" }),
        pdf.name,
      );
      response = await this.deps.transport.mediaRequest(
        "/drive/v1/medias/upload_all",
        form,
      );
    } else {
      const prepared = await this.request(
        "POST",
        "/drive/v1/medias/upload_prepare",
        {
          file_name: pdf.name,
          parent_type: "bitable_file",
          parent_node: base,
          size: pdf.size,
        },
      );
      const { upload_id, block_size, block_num } = prepared;
      if (
        !upload_id ||
        !Number.isSafeInteger(block_size) ||
        block_size <= 0 ||
        block_num !== Math.ceil(pdf.size / block_size)
      )
        throw new Error("飞书返回的分片上传参数无效");
      for (let seq = 0; seq < block_num; seq++) {
        const size = Math.min(block_size, pdf.size - seq * block_size);
        const bytes = await this.deps.readBytes(
          pdf.path,
          seq * block_size,
          size,
        );
        if (bytes.byteLength !== size)
          throw new Error(`PDF 在读取时发生变化：${pdf.name}`);
        const form = new win.FormData();
        form.append("upload_id", upload_id);
        form.append("seq", String(seq));
        form.append("size", String(size));
        form.append("file", new win.Blob([bytes]), pdf.name);
        await this.deps.transport.mediaRequest(
          "/drive/v1/medias/upload_part",
          form,
        );
      }
      response = await this.request("POST", "/drive/v1/medias/upload_finish", {
        upload_id,
        block_num,
      });
    }
    if (typeof response.file_token !== "string" || !response.file_token)
      throw new Error("飞书未返回附件 file_token");
    return response.file_token;
  }

  private async request(
    method: string,
    path: string,
    body?: Json,
  ): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.transport.request(method, path, body);
      } catch (error) {
        if (
          !(error instanceof FeishuError) ||
          error.code !== 1254291 ||
          attempt >= 3
        )
          throw error;
        await Zotero.Promise.delay(500 * 2 ** attempt);
      }
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const turn = BitableSyncService.queue.then(operation);
    BitableSyncService.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}

function nextPage(response: Json, seen: Set<string>): string {
  if (!response.has_more) return "";
  const token = response.page_token;
  if (typeof token !== "string" || !token || seen.has(token))
    throw new Error("飞书分页信息无效");
  seen.add(token);
  return token;
}
function requireRecord(response: Json): RemoteRecord {
  if (
    typeof response.record?.record_id !== "string" ||
    !response.record.record_id
  )
    throw new Error("飞书未确认记录写入成功");
  return response.record;
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map((v) => v.text || "").join("") : "";
}
function topLevel(item: Zotero.Item): Zotero.Item {
  return item.isRegularItem() ? item : item.topLevelItem || item;
}
function field(item: Zotero.Item, name: string): string {
  return String(item.getField(name as any, false, true) || "");
}
function link(value: string): { text: string; link: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol)
      ? { text: value, link: url.href }
      : null;
  } catch {
    return null;
  }
}
function sourceFields(item: Zotero.Item, includeClassification = false): Json {
  const collections = collectionPaths(item);
  const doi = field(item, "DOI")
    .replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, "")
    .trim();
  const fields: Json = {
    文献标题: field(item, "title"),
    作者: item
      .getCreators()
      .map(
        (c: any) =>
          c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
      )
      .filter(Boolean)
      .join("; "),
    年份: field(item, "date").match(/\b\d{4}\b/)?.[0] || "",
    期刊或会议:
      field(item, "publicationTitle") ||
      field(item, "conferenceName") ||
      field(item, "proceedingsTitle"),
    摘要: field(item, "abstractNote"),
    DOI: doi ? link(`https://doi.org/${doi}`) : null,
    原文链接: link(field(item, "url")),
    "Zotero 分类": collections.join("; "),
    "Zotero 标签": item
      .getTags()
      .map((t) => t.tag)
      .join("; "),
    [UNIQUE]: `${item.libraryID}:${item.key}`,
  };
  // Native multi-select values keep folder names containing semicolons intact.
  // Zotero owns this column, so an empty array also clears stale membership.
  if (includeClassification) fields.分类 = collections;
  if (item.libraryID === Zotero.Libraries.userLibraryID) {
    const userID = Zotero.Users.getCurrentUserID();
    if (userID)
      fields["Zotero 条目链接"] = link(
        `https://www.zotero.org/users/${userID}/items/${item.key}`,
      );
    else fields["Zotero 条目链接"] = localItemLink(item.key);
  } else {
    const groupID = Zotero.Groups.getGroupIDFromLibraryID(item.libraryID);
    if (groupID)
      fields["Zotero 条目链接"] = link(
        `https://www.zotero.org/groups/${groupID}/items/${item.key}`,
      );
  }
  return fields;
}
function collectionPaths(item: Zotero.Item): string[] {
  return Array.from(
    new Set(
      item
        .getCollections()
        .map((id) => {
          const names: string[] = [];
          let collection: Zotero.Collection | false =
            Zotero.Collections.get(id);
          const seen = new Set<number>();
          while (collection) {
            if (seen.has(collection.id)) throw new Error("Zotero 分类层级循环");
            seen.add(collection.id);
            names.unshift(collection.name);
            collection = collection.parentID
              ? Zotero.Collections.get(collection.parentID)
              : false;
          }
          return names.join(" / ");
        })
        .filter(Boolean),
    ),
  );
}
function io(): any {
  return ztoolkit.getGlobal("IOUtils");
}
function statePath(): string {
  const paths = ztoolkit.getGlobal("PathUtils") as any;
  return paths.join(paths.profileDir, "zotero-feishu", "bitable-state.json");
}
async function readState(): Promise<BitableState> {
  try {
    const state = JSON.parse(await io().readUTF8(statePath()));
    if (
      state.version !== 1 ||
      !state.records ||
      !state.uploads ||
      !state.pendingCreates ||
      [state.records, state.uploads, state.pendingCreates].some(
        (m) =>
          typeof m !== "object" ||
          Array.isArray(m) ||
          Object.values(m).some((v) => typeof v !== "string"),
      )
    )
      throw new Error("多维表格同步状态损坏，已停止写入");
    return state;
  } catch (error) {
    if (
      ["NotFoundError", "NS_ERROR_FILE_NOT_FOUND"].includes(
        (error as Error).name,
      )
    )
      return { version: 1, records: {}, uploads: {}, pendingCreates: {} };
    throw error;
  }
}
async function writeState(state: BitableState): Promise<void> {
  const path = statePath();
  const paths = ztoolkit.getGlobal("PathUtils") as any;
  await io().makeDirectory(paths.parent(path), { ignoreExisting: true });
  await io().writeUTF8(path, JSON.stringify(state), { tmpPath: `${path}.tmp` });
}
async function localPdfs(item: Zotero.Item): Promise<BitablePdf[]> {
  const pdfs: BitablePdf[] = [];
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (!attachment?.isPDFAttachment()) continue;
    const path = await attachment.getFilePathAsync();
    if (!path || !(await io().exists(path))) continue; // Only locally available PDFs.
    const stat = await io().stat(path);
    const hash = await Zotero.Utilities.Internal.md5Async(path);
    pdfs.push({
      key: attachment.key,
      name: attachment.attachmentFilename || `${attachment.key}.pdf`,
      path,
      size: stat.size,
      fingerprint: hash,
    });
  }
  return pdfs;
}
