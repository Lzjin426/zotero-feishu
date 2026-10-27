import { assert } from "chai";
import { FeishuError } from "../src/modules/feishu/transport";
import {
  ReadingNotesService,
  type ReadingNotesInput,
  type ReadingNotesCheckpoint,
  type ReadingNotesMapping,
} from "../src/modules/readingNotes";

function fixture() {
  const nodes: Record<string, Record<string, unknown>> = {
    parent: { node_token: "parent", space_id: "space" },
  };
  const body: unknown[] = [];
  const calls: {
    method: string;
    path: string;
    data?: Record<string, unknown>;
  }[] = [];
  const checkpoints: ReadingNotesCheckpoint[] = [];
  let createMode = "normal";
  let appendMode = "normal";
  let page = false;
  let forbidden = "";
  const marker = "[Zotero阅读 base/table/library:item]";
  const add = (token = "note", title = marker) => {
    nodes[token] = {
      node_token: token,
      space_id: "space",
      parent_node_token: "parent",
      obj_type: "docx",
      obj_token: `doc-${token}`,
      node_type: "origin",
      title,
    };
  };
  const transport = {
    async request(
      method: string,
      path: string,
      data?: Record<string, unknown>,
      options?: { beforeSend?: () => void | Promise<void> },
    ): Promise<Record<string, unknown>> {
      calls.push({ method, path, data });
      if (path.startsWith("/wiki/v2/spaces/get_node")) {
        const token = new URL(`https://api.test${path}`).searchParams.get(
          "token",
        )!;
        if (token === forbidden || !nodes[token])
          throw new Error("403 or missing");
        return { node: { ...nodes[token] } };
      }
      if (method === "GET" && path.includes("/nodes?")) {
        if (page && !path.includes("page_token=")) {
          return { items: [], has_more: true, page_token: "next" };
        }
        return {
          items: Object.values(nodes).filter(
            (n) => n.parent_node_token === "parent",
          ),
          has_more: false,
        };
      }
      if (method === "POST" && path.endsWith("/nodes")) {
        if (createMode === "auth-failure")
          throw new Error("Token expired before sending");
        await options?.beforeSend?.();
        if (createMode === "forbidden") throw new FeishuError("Forbidden", 403);
        if (createMode === "uncertain-empty")
          throw new FeishuError("Uncertain", 500);
        add();
        if (createMode === "duplicate") add("duplicate");
        if (createMode === "timeout") throw new Error("create timeout");
        return { node: nodes.note };
      }
      if (path.endsWith("/update_title")) {
        const token = path.split("/").at(-2)!;
        nodes[token].title = data!.title;
        return {};
      }
      if (method === "GET" && path.includes("/children?"))
        return { items: [...body] };
      if (method === "POST" && path.includes("/children?")) {
        if (appendMode === "empty-timeout") {
          appendMode = "normal";
          throw new Error("append timeout before write");
        }
        body.push(...(data!.children as unknown[]));
        if (appendMode === "timeout")
          throw new Error("append timeout after write");
        return {};
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  const input: ReadingNotesInput = {
    parentWikiToken: "parent",
    sourceKey: "base/table/library:item",
    title: "论文标题",
    zoteroURL: "zotero://select/library/items/ITEM",
    baseRecordURL: "https://my.feishu.cn/base/base?record=record",
    checkpoint: async (value) => {
      checkpoints.push({ ...value });
    },
    assertCurrent: () => {},
  };
  return {
    nodes,
    body,
    calls,
    checkpoints,
    input,
    add,
    service: new ReadingNotesService(
      transport,
      () => "00000000-0000-4000-8000-000000000001",
    ),
    setCreateMode: (value: string) => {
      createMode = value;
    },
    setAppendMode: (value: string) => {
      appendMode = value;
    },
    setPage: () => {
      page = true;
    },
    forbid: (value: string) => {
      forbidden = value;
    },
  };
}

async function rejects(action: () => Promise<unknown>, message: string) {
  try {
    await action();
  } catch (error) {
    assert.include(String(error), message);
    return;
  }
  assert.fail("Expected failure");
}

function writes(f: ReturnType<typeof fixture>, suffix: string) {
  return f.calls.filter((c) => c.method === "POST" && c.path.includes(suffix));
}

describe("ReadingNotesService", function () {
  it("allows a safe retry after token failure before HTTP dispatch", async function () {
    const f = fixture();
    f.setCreateMode("auth-failure");
    await rejects(
      () => f.service.ensure(f.input),
      "Token expired before sending",
    );
    f.input.mapping = f.checkpoints.at(-1);
    assert.equal((f.input.mapping as any).creationStatus, "not-sent");
    f.setCreateMode("normal");
    await f.service.ensure(f.input);
    assert.equal(Object.keys(f.nodes).length, 2);
  });

  it("allows retry after a definite rejection, without retrying an ambiguous create", async function () {
    const f = fixture();
    f.setCreateMode("forbidden");
    await rejects(() => f.service.ensure(f.input), "Forbidden");
    f.input.mapping = f.checkpoints.at(-1);
    assert.equal((f.input.mapping as any).creationStatus, "not-sent");
    f.setCreateMode("normal");
    await f.service.ensure(f.input);
    assert.equal(Object.keys(f.nodes).length, 2);

    const ambiguous = fixture();
    ambiguous.setCreateMode("uncertain-empty");
    await rejects(() => ambiguous.service.ensure(ambiguous.input), "Uncertain");
    ambiguous.input.mapping = ambiguous.checkpoints.at(-1);
    ambiguous.setCreateMode("normal");
    await rejects(
      () => ambiguous.service.ensure(ambiguous.input),
      "创建结果待核",
    );
    assert.lengthOf(writes(ambiguous, "/nodes"), 1);
  });

  it("safely retries when cancelled after saving intent but before sending", async function () {
    const f = fixture();
    let cancelled = false;
    f.input.checkpoint = async (value) => {
      f.checkpoints.push({ ...value });
      if (value.state === "pending" && value.creationStatus === "uncertain")
        cancelled = true;
    };
    f.input.assertCurrent = () => {
      if (cancelled) throw new Error("cancelled");
    };
    await rejects(() => f.service.ensure(f.input), "cancelled");
    assert.lengthOf(writes(f, "/nodes"), 0);
    f.input.mapping = f.checkpoints.at(-1);
    f.input.checkpoint = async (value) => {
      f.checkpoints.push({ ...value });
    };
    cancelled = false;
    await f.service.ensure(f.input);
    assert.lengthOf(
      f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/nodes")),
      1,
    );
  });

  it("persists intent and identity before renaming, then initializes native blocks", async function () {
    const f = fixture();
    f.input.checkpoint = async (value) => {
      if (value.state === "ready" && value.initializePending) {
        assert.equal(
          f.nodes.note.title,
          "[Zotero阅读 base/table/library:item]",
        );
      }
      f.checkpoints.push({ ...value });
    };
    const result = await f.service.ensure(f.input);
    assert.deepEqual(
      f.checkpoints.map((c) => c.state),
      ["pending", "pending", "ready", "ready"],
    );
    assert.equal(result.initializePending, false);
    assert.equal(f.nodes.note.title, "论文标题");
    assert.lengthOf(f.body, 7);
    assert.include(JSON.stringify(f.body), f.input.sourceKey);
    assert.include(JSON.stringify(f.body), f.input.zoteroURL);
    assert.include(JSON.stringify(f.body), f.input.baseRecordURL);
    assert.match(result.clientToken, /^[\da-f-]{36}$/);
  });

  it("recovers a creation timeout by scanning without creating again", async function () {
    const f = fixture();
    f.setCreateMode("timeout");
    await f.service.ensure(f.input);
    assert.lengthOf(
      f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/nodes")),
      1,
    );
  });

  it("fails closed when internal POST retries produced duplicate markers", async function () {
    const f = fixture();
    f.setCreateMode("duplicate");
    await rejects(() => f.service.ensure(f.input), "多个同名");
    assert.lengthOf(writes(f, "update_title"), 0);
    assert.isEmpty(f.body);
    assert.equal(f.checkpoints.at(-1)!.state, "pending");
  });

  it("recovers a persisted pending marker across paginated children", async function () {
    const f = fixture();
    f.add();
    f.setPage();
    f.input.mapping = {
      state: "pending",
      sourceKey: f.input.sourceKey,
      spaceID: "space",
      parentWikiToken: "parent",
      marker: String(f.nodes.note.title),
    };
    await f.service.ensure(f.input);
    assert.isTrue(f.calls.some((c) => c.path.includes("page_token=next")));
    assert.lengthOf(
      f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/nodes")),
      0,
    );
  });

  it("does not recreate an uncertain pending operation with no visible node", async function () {
    const f = fixture();
    f.input.mapping = {
      state: "pending",
      sourceKey: f.input.sourceKey,
      spaceID: "space",
      parentWikiToken: "parent",
      marker: "pending-marker",
    };
    await rejects(() => f.service.ensure(f.input), "停止重复创建");
    assert.isEmpty(f.calls.filter((c) => c.method === "POST"));
  });

  it("preserves all existing content while recovering a new node", async function () {
    const f = fixture();
    f.add();
    f.body.push({ block_type: 2, text: { elements: [] } });
    const before = JSON.stringify(f.body);
    await f.service.ensure(f.input);
    assert.equal(JSON.stringify(f.body), before);
    assert.lengthOf(writes(f, "/children?"), 0);
  });

  it("does not append twice when initialization timed out after writing", async function () {
    const f = fixture();
    f.setAppendMode("timeout");
    await f.service.ensure(f.input);
    assert.lengthOf(writes(f, "/children?"), 1);
    assert.lengthOf(f.body, 7);
  });

  it("reads before retrying an empty initialization and reuses its UUID", async function () {
    const f = fixture();
    f.setAppendMode("empty-timeout");
    await f.service.ensure(f.input);
    const appends = writes(f, "/children?");
    assert.lengthOf(appends, 2);
    assert.equal(appends[0].path, appends[1].path);
    assert.include(appends[0].path, "client_token=");
    assert.lengthOf(f.body, 7);
  });

  it("reuses a remote URL and only changes the title, preserving user body", async function () {
    const f = fixture();
    f.add("note", "旧标题");
    f.body.push({ user: "notes" });
    f.input.remoteWikiURL = "https://team.feishu.cn/wiki/note";
    const result = await f.service.ensure(f.input);
    assert.equal(result.wikiURL, f.input.remoteWikiURL);
    assert.deepEqual(f.body, [{ user: "notes" }]);
    assert.lengthOf(
      f.calls.filter((c) => c.method === "POST"),
      1,
    );
    assert.equal(f.nodes.note.title, f.input.title);
  });

  it("reuses local mapping and preserves notes on subsequent title changes", async function () {
    const f = fixture();
    f.input.mapping = await f.service.ensure(f.input);
    f.body.push({ user: "阅读心得" });
    const before = JSON.stringify(f.body);
    f.calls.length = 0;
    f.input.title = "更新论文标题";
    await f.service.ensure(f.input);
    assert.equal(JSON.stringify(f.body), before);
    assert.lengthOf(
      f.calls.filter((c) => c.method === "POST"),
      1,
    );
    assert.equal(f.nodes.note.title, f.input.title);
  });

  for (const [field, value] of [
    ["parent_node_token", "other-parent"],
    ["space_id", "other-space"],
    ["obj_type", "sheet"],
    ["node_type", "shortcut"],
  ]) {
    it(`rejects existing nodes with incorrect ${field}`, async function () {
      const f = fixture();
      f.add();
      f.nodes.note[field] = value;
      f.input.remoteWikiURL = "https://my.feishu.cn/wiki/note";
      await rejects(() => f.service.ensure(f.input), "目标父节点");
      assert.isEmpty(f.calls.filter((c) => c.method === "POST"));
    });
  }

  it("does not silently create when a linked node is inaccessible", async function () {
    const f = fixture();
    f.input.remoteWikiURL = "https://my.feishu.cn/wiki/missing";
    await rejects(() => f.service.ensure(f.input), "403");
    assert.isEmpty(f.calls.filter((c) => c.method === "POST"));
  });

  it("rejects conflicting remote and local identities", async function () {
    const f = fixture();
    f.input.mapping = await f.service.ensure(f.input);
    f.add("other", "其他文档");
    f.input.remoteWikiURL = "https://my.feishu.cn/wiki/other";
    f.calls.length = 0;
    await rejects(() => f.service.ensure(f.input), "映射冲突");
    assert.isEmpty(f.calls.filter((c) => c.method === "POST"));
  });

  it("rejects source, parent and document mapping conflicts", async function () {
    for (const field of ["sourceKey", "parentWikiToken", "documentID"]) {
      const f = fixture();
      const mapping = await f.service.ensure(f.input);
      f.input.mapping = { ...mapping, [field]: "wrong" } as ReadingNotesMapping;
      f.calls.length = 0;
      await rejects(() => f.service.ensure(f.input), "冲突");
      assert.isEmpty(f.calls.filter((c) => c.method === "POST"));
    }
  });

  it("stops before creating if checkpoint persistence fails", async function () {
    const f = fixture();
    f.input.checkpoint = async () => {
      throw new Error("disk failed");
    };
    await rejects(() => f.service.ensure(f.input), "disk failed");
    assert.isEmpty(f.calls.filter((c) => c.method === "POST"));
  });

  it("checks cancellation after saving identity and before renaming", async function () {
    const f = fixture();
    let cancelled = false;
    f.input.checkpoint = async (value) => {
      if (value.state === "ready") cancelled = true;
    };
    f.input.assertCurrent = () => {
      if (cancelled) throw new Error("cancelled");
    };
    await rejects(() => f.service.ensure(f.input), "cancelled");
    assert.lengthOf(writes(f, "update_title"), 0);
    assert.isEmpty(f.body);
  });

  it("resumes initialization from a checkpoint saved before renaming", async function () {
    const f = fixture();
    f.setAppendMode("empty-timeout");
    let saved: ReadingNotesCheckpoint | undefined;
    f.input.checkpoint = async (value) => {
      saved = { ...value };
      if (value.state === "ready") throw new Error("interrupted");
    };
    await rejects(() => f.service.ensure(f.input), "interrupted");
    f.input.mapping = saved;
    f.input.checkpoint = async () => {};
    await f.service.ensure(f.input);
    assert.lengthOf(f.body, 7);
    assert.equal(f.nodes.note.title, f.input.title);
  });
});
