/// <reference types="mocha" />
import { assert } from "chai";
import {
  BitableSyncService,
  type BitableState,
  type BitableSyncDependencies,
  type BitablePdf,
} from "../src/modules/bitableSync";
import type { OAuthService } from "../src/modules/oauthService";
import { FeishuError } from "../src/modules/feishu/transport";

type Json = Record<string, any>;
const HANDWRITTEN = [
  "阅读状态",
  "优先级",
  "研究问题",
  "研究对象或样本",
  "研究方法",
  "主要发现",
  "局限与不足",
  "与课题的关系",
  "阅读笔记",
];
const TEXT_FIELDS = [
  "文献标题",
  "作者",
  "年份",
  "期刊或会议",
  "摘要",
  "Zotero 分类",
  "Zotero 标签",
  "Zotero 唯一标识",
];
const SCHEMA = [
  ...TEXT_FIELDS.map((field_name) => ({ field_name, type: 1 })),
  ...["DOI", "原文链接", "Zotero 条目链接"].map((field_name) => ({
    field_name,
    type: 15,
  })),
  { field_name: "最近同步时间", type: 5 },
  { field_name: "PDF 附件", type: 17 },
];

describe("BitableSyncService", function () {
  it("links titles to reusable reading notes and retains handwritten fields", async function () {
    const f = fixture();
    f.preferences.readingNotesParent = "https://my.feishu.cn/wiki/parent";
    f.schema.push({ field_name: "阅读文档", type: 15 });
    const inputs: any[] = [];
    const service = f.newService({
      readingNote: async (input) => {
        inputs.push(input);
        const mapping = {
          state: "ready" as const,
          sourceKey: input.sourceKey,
          spaceID: "space",
          parentWikiToken: "parent",
          nodeToken: "note",
          documentID: "doc",
          wikiURL: "https://my.feishu.cn/wiki/note",
          initializePending: false,
          clientToken: "uuid",
        };
        await input.checkpoint(mapping);
        return mapping;
      },
    });
    assert.equal(
      (await service.syncItem(item("Paper [one]"))).outcome,
      "created",
    );
    f.rows[0].fields.阅读状态 = "已读";
    f.rows[0].fields.优先级 = "高";
    assert.equal(
      (await service.syncItem(item("Revised paper"))).outcome,
      "updated",
    );
    assert.lengthOf(f.rows, 1);
    assert.equal(f.rows[0].fields.阅读状态, "已读");
    assert.equal(f.rows[0].fields.优先级, "高");
    assert.equal(inputs[1].remoteWikiURL, "https://my.feishu.cn/wiki/note");
    assert.equal(inputs[1].mapping.nodeToken, "note");
    assert.include(f.titleLinks[0], "Paper \\[one\\]");
    assert.include(
      f.titleLinks[1],
      "[Revised paper](https://my.feishu.cn/wiki/note)",
    );
  });

  it("retains note checkpoints when linking the title fails", async function () {
    const f = fixture();
    f.preferences.readingNotesParent = "parent";
    f.schema.push({ field_name: "阅读文档", type: 15 });
    let calls = 0;
    const service = f.newService({
      readingNote: async (input) => {
        calls++;
        const mapping = {
          state: "ready" as const,
          sourceKey: input.sourceKey,
          spaceID: "space",
          parentWikiToken: "parent",
          nodeToken: "note",
          documentID: "doc",
          wikiURL: "https://my.feishu.cn/wiki/note",
          initializePending: false,
          clientToken: "uuid",
        };
        await input.checkpoint(mapping);
        return mapping;
      },
    });
    f.failTitleLink = true;
    assert.equal((await service.syncItem(item())).outcome, "failed");
    assert.exists(Object.values(f.state().readingNotes || {})[0]);
    f.failTitleLink = false;
    assert.equal((await service.syncItem(item())).outcome, "updated");
    assert.lengthOf(f.rows, 1);
    assert.equal(calls, 2);
  });

  it("checks the reading document schema before writing any record", async function () {
    const f = fixture();
    f.preferences.readingNotesParent = "parent";
    const failed = await f.service.syncItem(item());
    assert.equal(failed.outcome, "failed");
    assert.include(failed.errors[0], "阅读文档");
    assert.lengthOf(f.writes, 0);
  });

  it("synchronizes full folder paths as multi-select tags and clears removed memberships", async function () {
    const f = fixture();
    f.schema.push({ field_name: "分类", type: 4 });
    const root = new Zotero.Collection();
    root.name = "Gearbox";
    await root.saveTx();
    const child = new Zotero.Collection();
    child.name = "Optimization; methods";
    child.parentID = root.id;
    await child.saveTx();
    const paper = item();
    let membership = [root.id, child.id, child.id];
    paper.getCollections = () => membership;
    try {
      assert.equal((await f.service.syncItem(paper)).outcome, "created");
      assert.deepEqual(f.rows[0].fields.分类, [
        "Gearbox",
        "Gearbox / Optimization; methods",
      ]);
      f.rows[0].fields.阅读状态 = "已读";
      f.rows[0].fields.优先级 = "高";
      root.name = "Drivetrain";
      await root.saveTx();
      membership = [child.id];
      await f.service.syncItem(paper);
      assert.deepEqual(f.rows[0].fields.分类, [
        "Drivetrain / Optimization; methods",
      ]);
      child.parentID = false;
      await child.saveTx();
      membership = [child.id];
      assert.equal((await f.service.syncItem(paper)).outcome, "updated");
      assert.deepEqual(f.rows[0].fields.分类, ["Optimization; methods"]);
      assert.equal(f.rows[0].fields["Zotero 分类"], "Optimization; methods");
      membership = [root.id];
      await f.service.syncItem(paper);
      assert.deepEqual(f.rows[0].fields.分类, ["Drivetrain"]);
      membership = [];
      await f.service.syncItem(paper);
      assert.deepEqual(f.rows[0].fields.分类, []);
      assert.equal(f.rows[0].fields.阅读状态, "已读");
      assert.equal(f.rows[0].fields.优先级, "高");
      assert.lengthOf(f.rows, 1);
    } finally {
      await child.eraseTx();
      await root.eraseTx();
    }
  });

  it("keeps old tables compatible and rejects a wrongly typed classification column", async function () {
    const f = fixture();
    assert.equal((await f.service.syncItem(item())).outcome, "created");
    assert.notProperty(f.writes[0].fields, "分类");
    f.schema.push({ field_name: "分类", type: 1 });
    const failed = await f.service.syncItem(item());
    assert.equal(failed.outcome, "failed");
    assert.include(failed.errors[0], "分类（应为多选）");
    assert.lengthOf(f.writes, 1);
  });

  it("rechecks the destination after waiting in the global write queue", async function () {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f
      .newService({
        readState: async () => {
          entered();
          await gate;
          return f.state();
        },
      })
      .syncItem(item());
    await started;
    let allowed = true;
    const second = f.newService().syncItem(item(), () => {
      if (!allowed) throw new Error("Destination changed");
    });
    allowed = false;
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results[1].outcome, "failed");
    assert.include(results[1].errors[0], "Destination changed");
    assert.lengthOf(f.writes, 1);
  });

  it("creates source fields using the official record and URL shapes", async function () {
    const f = fixture();
    const result = await f.service.syncItem(item());
    assert.equal(result.outcome, "created");
    assert.match(
      result.documentUrl!,
      /\/base\/baseTest\?table=tblTest&record=rec1$/,
    );
    const create = f.writes[0];
    assert.match(create.path, /records\?client_token=[\w-]+$/);
    assert.equal(
      create.fields["Zotero 唯一标识"],
      `${Zotero.Libraries.userLibraryID}:ITEM1234`,
    );
    assert.deepEqual(create.fields.DOI, {
      text: "https://doi.org/10.1000/test",
      link: "https://doi.org/10.1000/test",
    });
    assert.equal(create.fields.最近同步时间, 1700000000000);
    assert.equal(create.fields.作者, "Ada Lovelace");
    assert.equal(create.fields.年份, "2024");
    assert.lengthOf(Object.keys(f.state().records), 1);
  });

  it("finds the remote unique key on every sync and never creates twice", async function () {
    const f = fixture();
    await f.service.syncItem(item());
    await f.service.syncItem(item());
    assert.equal(f.writes.filter((w) => w.method === "POST").length, 1);
    assert.equal(f.writes.filter((w) => w.method === "PUT").length, 1);
    assert.equal(f.searches.length, 2);
    assert.deepEqual(f.searches[0].filter, {
      conjunction: "and",
      conditions: [
        {
          field_name: "Zotero 唯一标识",
          operator: "is",
          value: [`${Zotero.Libraries.userLibraryID}:ITEM1234`],
        },
      ],
    });
  });

  it("updates only source fields and preserves every handwritten field", async function () {
    const f = fixture();
    await f.service.syncItem(item());
    for (const name of HANDWRITTEN) f.rows[0].fields[name] = `manual-${name}`;
    await f.service.syncItem(item("Revised title"));
    assert.equal(f.rows[0].fields.文献标题, "Revised title");
    for (const name of HANDWRITTEN) {
      assert.equal(f.rows[0].fields[name], `manual-${name}`);
      assert.notProperty(f.writes[1].fields, name);
    }
  });

  it("recovers a record after all local mapping state is lost", async function () {
    const f = fixture();
    await f.service.syncItem(item());
    f.reset();
    const result = await f.newService().syncItem(item());
    assert.equal(result.outcome, "updated");
    assert.lengthOf(f.rows, 1);
    assert.equal(Object.values(f.state().records)[0], "rec1");
  });

  it("fails closed when the unique key matches multiple remote rows", async function () {
    const f = fixture();
    await f.service.syncItem(item());
    f.rows.push(clone(f.rows[0]));
    const result = await f.service.syncItem(item());
    assert.equal(result.outcome, "failed");
    assert.include(result.errors[0], "多条记录");
    assert.lengthOf(f.writes, 1);
  });

  it("uploads all local PDFs once and preserves manually attached files", async function () {
    const f = fixture();
    f.pdfs.push(pdf("PDF1"), pdf("PDF2"));
    await f.service.syncItem(item());
    f.rows[0].fields["PDF 附件"].push({
      file_token: "manual-file",
      name: "notes.txt",
    });
    await f.service.syncItem(item());
    assert.equal(f.uploads.length, 2);
    assert.deepEqual(f.rows[0].fields["PDF 附件"], [
      { file_token: "file1" },
      { file_token: "file2" },
      { file_token: "manual-file", name: "notes.txt" },
    ]);
    assert.notProperty(f.writes[1].fields, "PDF 附件");
    const form = f.uploads[0].form;
    assert.equal(form.get("parent_node"), "baseTest");
    assert.equal(form.get("parent_type"), "bitable_file");
    assert.equal(form.get("size"), "3");
    assert.equal(form.get("file_name"), "PDF1.pdf");
  });

  it("retains successful upload checkpoints when a later upload fails", async function () {
    const f = fixture();
    f.pdfs.push(pdf("PDF1"), pdf("PDF2"));
    f.failUploadAt = 2;
    const failed = await f.service.syncItem(item());
    assert.equal(failed.outcome, "failed");
    assert.lengthOf(f.rows, 0);
    assert.lengthOf(Object.keys(f.state().records), 0);
    assert.lengthOf(Object.keys(f.state().uploads), 1);
    f.failUploadAt = 0;
    const retried = await f.newService().syncItem(item());
    assert.equal(retried.outcome, "created");
    assert.equal(f.uploads.length, 3);
    assert.lengthOf(f.rows[0].fields["PDF 附件"], 2);
  });

  it("reuses uploaded PDFs after a failed record write", async function () {
    const f = fixture();
    f.pdfs.push(pdf("PDF1"));
    f.failWrite = true;
    assert.equal((await f.service.syncItem(item())).outcome, "failed");
    assert.lengthOf(Object.keys(f.state().records), 0);
    const pending = Object.values(f.state().pendingCreates)[0];
    f.failWrite = false;
    assert.equal((await f.service.syncItem(item())).outcome, "created");
    assert.equal(f.uploads.length, 1);
    assert.include(f.writes[0].path, pending);
    assert.include(f.writes[1].path, pending);
  });

  it("recovers a committed create whose response timed out", async function () {
    const f = fixture();
    f.timeoutAfterCreate = true;
    assert.equal((await f.service.syncItem(item())).outcome, "failed");
    assert.lengthOf(Object.keys(f.state().records), 0);
    f.timeoutAfterCreate = false;
    assert.equal((await f.newService().syncItem(item())).outcome, "updated");
    assert.lengthOf(f.rows, 1);
    assert.equal(f.writes.filter((w) => w.method === "POST").length, 1);
  });

  it("uploads changed PDF contents while retaining existing attachments", async function () {
    const f = fixture();
    f.pdfs.push(pdf("PDF1"));
    await f.service.syncItem(item());
    f.pdfs[0].fingerprint = "changed-content";
    await f.service.syncItem(item());
    assert.equal(f.uploads.length, 2);
    assert.deepEqual(f.rows[0].fields["PDF 附件"], [
      { file_token: "file1" },
      { file_token: "file2" },
    ]);
  });

  it("does not touch attachment fields when PDF sync is disabled or no local PDF exists", async function () {
    const f = fixture();
    f.pdfs.push(pdf("PDF1"));
    f.preferences.syncPDF = false;
    await f.service.syncItem(item());
    assert.notProperty(f.writes[0].fields, "PDF 附件");
    f.preferences.syncPDF = true;
    f.pdfs.length = 0;
    f.rows[0].fields["PDF 附件"] = [{ file_token: "manual" }];
    await f.service.syncItem(item());
    assert.notProperty(f.writes[1].fields, "PDF 附件");
    assert.deepEqual(f.rows[0].fields["PDF 附件"], [{ file_token: "manual" }]);
  });

  it("serializes complete sync operations across service instances", async function () {
    const f = fixture();
    const results = await Promise.all([
      f.service.syncItem(item()),
      f.newService().syncItem(item()),
    ]);
    assert.deepEqual(
      results.map((r) => r.outcome),
      ["created", "updated"],
    );
    assert.lengthOf(f.rows, 1);
  });

  it("fails without writing when remote search fails", async function () {
    const f = fixture();
    f.failSearch = true;
    const result = await f.service.syncItem(item());
    assert.equal(result.outcome, "failed");
    assert.lengthOf(f.writes, 0);
    assert.lengthOf(Object.keys(f.state().records), 0);
  });

  it("rejects invalid schemas before any upload or record write", async function () {
    const f = fixture();
    f.schema = f.schema.filter((s) => s.field_name !== "DOI");
    const result = await f.service.syncItem(item());
    assert.equal(result.outcome, "failed");
    assert.include(result.errors[0], "DOI");
    assert.lengthOf(f.writes, 0);
  });

  it("supports numeric year fields and clears removed source URLs", async function () {
    const f = fixture();
    f.schema.find((s) => s.field_name === "年份")!.type = 2;
    await f.service.syncItem(item());
    assert.strictEqual(f.rows[0].fields.年份, 2024);
    await f.service.syncItem(item("Title", { DOI: "", url: "", date: "" }));
    assert.isNull(f.rows[0].fields.DOI);
    assert.isNull(f.rows[0].fields.原文链接);
    assert.isNull(f.rows[0].fields.年份);
  });

  it("opens records by remote key even without state, including child items", async function () {
    const f = fixture();
    const parent = item();
    await f.service.syncItem(parent);
    f.reset();
    const child = {
      isRegularItem: () => false,
      topLevelItem: parent,
    } as Zotero.Item;
    assert.isTrue(await f.service.openItem(child));
    assert.match(f.launched[0], /record=rec1$/);
    f.rows.length = 0;
    assert.isFalse(await f.service.openItem(parent));
  });

  it("tests connectivity without writes and rejects Wiki URLs", async function () {
    const f = fixture();
    await f.service.testConnection();
    assert.lengthOf(f.writes, 0);
    assert.lengthOf(f.searches, 1);
    f.preferences.targetBase = "https://example.feishu.cn/wiki/notBase";
    assert.equal((await f.service.syncItem(item())).outcome, "failed");
  });

  it("keeps upload reuse isolated by target Base", async function () {
    const f = fixture();
    f.pdfs.push(pdf("PDF1"));
    await f.service.syncItem(item());
    f.rows.length = 0;
    f.preferences.targetBase = "baseOther";
    await f.service.syncItem(item());
    assert.equal(f.uploads.length, 2);
    assert.equal(f.uploads[1].form.get("parent_node"), "baseOther");
  });

  it("does not claim success when the API omits record confirmation", async function () {
    const f = fixture();
    f.omitConfirmation = true;
    const result = await f.service.syncItem(item());
    assert.equal(result.outcome, "failed");
    assert.lengthOf(Object.keys(f.state().records), 0);
  });

  it("reports disk errors after remote success and recovers without duplicates", async function () {
    const f = fixture();
    f.failMappingSave = true;
    assert.equal((await f.service.syncItem(item())).outcome, "failed");
    assert.lengthOf(Object.keys(f.state().records), 0);
    f.failMappingSave = false;
    assert.equal((await f.service.syncItem(item())).outcome, "updated");
    assert.lengthOf(f.rows, 1);
  });

  it("preserves files manually added during a slow PDF upload", async function () {
    const f = fixture();
    await f.service.syncItem(item());
    f.pdfs.push(pdf("PDF1"));
    const service = f.newService({
      transport: {
        ...f.dependencies.transport,
        mediaRequest: async (path, form) => {
          f.rows[0].fields["PDF 附件"] = [
            { file_token: "added-during-upload" },
          ];
          return f.dependencies.transport.mediaRequest(path, form);
        },
      },
    });
    assert.equal((await service.syncItem(item())).outcome, "updated");
    assert.deepEqual(f.rows[0].fields["PDF 附件"], [
      { file_token: "added-during-upload" },
      { file_token: "file1" },
    ]);
  });

  it("uses prepare, ordered multipart parts, and finish for large PDFs", async function () {
    const f = fixture();
    const size = 20 * 1024 * 1024 + 1;
    f.pdfs.push({ ...pdf("BIG"), size });
    const calls: string[] = [];
    const service = f.newService({
      readBytes: async (_path, _offset, count) => new Uint8Array(count!),
      transport: {
        request: async (method, path, body) => {
          if (path.endsWith("upload_prepare")) {
            calls.push("prepare");
            assert.equal(body!.parent_type, "bitable_file");
            assert.equal(body!.parent_node, "baseTest");
            return {
              upload_id: "upload1",
              block_size: 4 * 1024 * 1024,
              block_num: 6,
            };
          }
          if (path.endsWith("upload_finish")) {
            calls.push("finish");
            assert.deepEqual(body, { upload_id: "upload1", block_num: 6 });
            return { file_token: "large-file" };
          }
          return f.dependencies.transport.request(method, path, body);
        },
        mediaRequest: async (path, form) => {
          assert.equal(path, "/drive/v1/medias/upload_part");
          assert.equal(form.get("upload_id"), "upload1");
          calls.push(`part${form.get("seq")}`);
          return {};
        },
      },
    });
    assert.equal((await service.syncItem(item())).outcome, "created");
    assert.deepEqual(calls, [
      "prepare",
      "part0",
      "part1",
      "part2",
      "part3",
      "part4",
      "part5",
      "finish",
    ]);
    assert.deepEqual(f.rows[0].fields["PDF 附件"], [
      { file_token: "large-file" },
    ]);
  });

  it("follows schema and record pagination rather than assuming the first page is complete", async function () {
    const f = fixture();
    await f.service.syncItem(item());
    const service = f.newService({
      transport: {
        ...f.dependencies.transport,
        request: async (method, path, body) => {
          if (path.includes("/fields?"))
            return path.includes("page_token=")
              ? { items: f.schema.slice(5), has_more: false }
              : {
                  items: f.schema.slice(0, 5),
                  has_more: true,
                  page_token: "fields-next",
                };
          if (
            path.includes("/records/search?") &&
            !path.includes("page_token=")
          )
            return { items: [], has_more: true, page_token: "records-next" };
          return f.dependencies.transport.request(method, path, body);
        },
      },
    });
    assert.equal((await service.syncItem(item())).outcome, "updated");
    assert.lengthOf(f.rows, 1);
  });

  it("fails closed when record pagination cannot advance", async function () {
    const f = fixture();
    const service = f.newService({
      transport: {
        ...f.dependencies.transport,
        request: async (method, path, body) =>
          path.includes("/records/search?")
            ? { items: [], has_more: true, page_token: "same-token" }
            : f.dependencies.transport.request(method, path, body),
      },
    });
    assert.equal((await service.syncItem(item())).outcome, "failed");
    assert.lengthOf(f.writes, 0);
  });

  it("does not overwrite malformed remote attachments", async function () {
    const f = fixture();
    await f.service.syncItem(item());
    f.rows[0].fields["PDF 附件"] = [{ name: "missing-token" }];
    f.pdfs.push(pdf("PDF1"));
    assert.equal((await f.service.syncItem(item())).outcome, "failed");
    assert.lengthOf(f.writes, 1);
    assert.deepEqual(f.rows[0].fields["PDF 附件"], [{ name: "missing-token" }]);
  });
});

function fixture() {
  let state: BitableState = emptyState();
  let uuid = 0;
  const f = {
    rows: [] as Array<{ record_id: string; fields: Json }>,
    writes: [] as Array<{ method: string; path: string; fields: Json }>,
    searches: [] as Json[],
    titleLinks: [] as string[],
    failTitleLink: false,
    uploads: [] as Array<{ path: string; form: FormData }>,
    pdfs: [] as BitablePdf[],
    schema: clone(SCHEMA),
    preferences: {
      targetBase: "https://example.feishu.cn/base/baseTest?table=tblIgnored",
      targetTable: "tblTest",
      syncPDF: true,
      readingNotesParent: "",
    },
    launched: [] as string[],
    failWrite: false,
    failUploadAt: 0,
    timeoutAfterCreate: false,
    failSearch: false,
    omitConfirmation: false,
    failMappingSave: false,
    state: () => clone(state),
    reset: () => {
      state = emptyState();
    },
    service: undefined as unknown as BitableSyncService,
    dependencies: undefined as unknown as BitableSyncDependencies,
    newService: (overrides: Partial<BitableSyncDependencies> = {}) =>
      new BitableSyncService({} as OAuthService, { ...deps, ...overrides }),
  };
  const deps: BitableSyncDependencies = {
    readingNote: async () => {
      throw new Error("Reading notes should be disabled");
    },
    preference: (name) => f.preferences[name],
    readState: async () => clone(state),
    writeState: async (s) => {
      if (f.failMappingSave && Object.keys(s.records).length)
        throw new Error("Disk full");
      state = clone(s);
    },
    pdfs: async () => clone(f.pdfs),
    readBytes: async () => new Uint8Array([1, 2, 3]),
    now: () => 1700000000000,
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    launch: (url) => {
      f.launched.push(url);
    },
    transport: {
      request: async (method, path, body) => {
        if (path.includes("/fields?"))
          return { items: clone(f.schema), has_more: false };
        if (path.includes("/records/search?")) {
          if (f.failSearch) throw new FeishuError("Search denied", 403);
          f.searches.push(clone(body!));
          const key = (body as Json).filter.conditions[0].value[0];
          return {
            items: clone(
              f.rows.filter((r) => r.fields["Zotero 唯一标识"] === key),
            ),
            has_more: false,
          };
        }
        if (path.startsWith("/base/v3/")) {
          if (f.failTitleLink) throw new Error("Title link failed");
          const updates = (body as Json).update_records;
          for (const [id, fields] of Object.entries(updates) as [
            string,
            Json,
          ][]) {
            f.titleLinks.push(fields.文献标题);
            Object.assign(
              f.rows.find((r) => r.record_id === id)!.fields,
              fields,
            );
          }
          return {};
        }
        const fields = clone((body as Json).fields);
        f.writes.push({ method, path, fields });
        if (f.failWrite) throw new Error("Write failed");
        let record;
        if (method === "POST") {
          record = { record_id: `rec${f.rows.length + 1}`, fields };
          f.rows.push(record);
          if (f.timeoutAfterCreate) throw new Error("Timeout");
        } else {
          record = f.rows.find((r) =>
            path.endsWith(`/records/${r.record_id}`),
          )!;
          Object.assign(record.fields, fields);
        }
        return f.omitConfirmation ? {} : { record: clone(record) };
      },
      mediaRequest: async (path, form) => {
        f.uploads.push({ path, form });
        if (f.failUploadAt === f.uploads.length)
          throw new Error("Upload failed");
        return { file_token: `file${f.uploads.length}` };
      },
    },
  };
  f.dependencies = deps;
  f.service = f.newService();
  return f;
}
function item(
  title = "Example",
  overrides: Record<string, string> = {},
): Zotero.Item {
  const fields: Record<string, string> = {
    title,
    date: "2024-05-01",
    DOI: "10.1000/test",
    url: "https://example.org/paper",
    ...overrides,
  };
  return {
    libraryID: Zotero.Libraries.userLibraryID,
    key: "ITEM1234",
    isRegularItem: () => true,
    getField: (name: string) => fields[name] || "",
    getCreators: () => [{ firstName: "Ada", lastName: "Lovelace" }],
    getCollections: () => [],
    getTags: () => [{ tag: "gearbox" }],
  } as unknown as Zotero.Item;
}
function pdf(key: string): BitablePdf {
  return {
    key,
    name: `${key}.pdf`,
    path: `/mock/${key}.pdf`,
    size: 3,
    fingerprint: "hash",
  };
}
function emptyState(): BitableState {
  return { version: 1, records: {}, uploads: {}, pendingCreates: {} };
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
