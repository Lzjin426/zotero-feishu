/** The request result is the unwrapped Feishu `data` object. */
export interface ReadingNotesTransport {
  request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    options?: { retry?: boolean; beforeSend?: () => void | Promise<void> },
  ): Promise<Record<string, unknown>>;
}

export interface ReadingNotesIntent {
  state: "pending";
  sourceKey: string;
  spaceID: string;
  parentWikiToken: string;
  marker: string;
  creationStatus?: "not-sent" | "uncertain";
}

export interface ReadingNotesMapping {
  state: "ready";
  sourceKey: string;
  spaceID: string;
  parentWikiToken: string;
  nodeToken: string;
  documentID: string;
  wikiURL: string;
  /** Persisted until initialization succeeds or existing content is found. */
  initializePending: boolean;
  clientToken: string;
}

export type ReadingNotesCheckpoint = ReadingNotesIntent | ReadingNotesMapping;

export interface ReadingNotesInput {
  parentWikiToken: string;
  sourceKey: string;
  title: string;
  zoteroURL: string;
  baseRecordURL: string;
  remoteWikiURL?: string;
  mapping?: ReadingNotesCheckpoint;
  /** Must durably save before resolving. Failure stops all further writes. */
  checkpoint: (value: ReadingNotesCheckpoint) => Promise<void>;
  /** Throws when the calling sync has been cancelled or superseded. */
  assertCurrent: () => void | Promise<void>;
}

type Node = Record<string, unknown>;

export class ReadingNotesService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly transport: ReadingNotesTransport,
    private readonly uuid: () => string = randomUUID,
  ) {}

  ensure(input: ReadingNotesInput): Promise<ReadingNotesMapping> {
    const result = this.queue.then(() => this.ensureCurrent(input));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ensureCurrent(
    input: ReadingNotesInput,
  ): Promise<ReadingNotesMapping> {
    await input.assertCurrent();
    for (const value of [input.sourceKey, input.title, input.parentWikiToken]) {
      if (!value.trim()) throw new Error("阅读笔记缺少来源、标题或父节点");
    }
    const parentToken = wikiToken(input.parentWikiToken);
    const parent = await this.getNode(parentToken);
    const spaceID = required(parent.space_id, "父节点空间");
    const saved = input.mapping;
    if (
      saved &&
      (saved.sourceKey !== input.sourceKey ||
        saved.spaceID !== spaceID ||
        saved.parentWikiToken !== parentToken)
    ) {
      throw new Error("阅读笔记映射与来源或目标位置冲突");
    }
    let node: Node | undefined;
    if (saved?.state === "ready") {
      node = await this.getNode(saved.nodeToken);
      this.validateNode(node, spaceID, parentToken);
      if (node.obj_token !== saved.documentID) {
        throw new Error("阅读笔记文档映射冲突");
      }
    }
    if (input.remoteWikiURL) {
      const remote = await this.getNode(wikiToken(input.remoteWikiURL));
      this.validateNode(remote, spaceID, parentToken);
      if (node && node.node_token !== remote.node_token) {
        throw new Error("远端链接与本地阅读笔记映射冲突");
      }
      if (saved?.state === "pending") {
        throw new Error("远端链接与未完成的创建意图冲突");
      }
      node = remote;
    }
    let initializePending =
      saved?.state === "ready" ? saved.initializePending : false;
    if (!node) {
      const marker =
        saved?.state === "pending"
          ? saved.marker
          : `[Zotero阅读 ${input.sourceKey}]`;
      let matches = await this.findMarker(spaceID, parentToken, marker);
      if (!matches.length) {
        if (saved?.state === "pending" && saved.creationStatus !== "not-sent") {
          throw new Error("创建结果待核：未找到临时节点，停止重复创建");
        }
        const intent: ReadingNotesIntent = {
          state: "pending",
          sourceKey: input.sourceKey,
          spaceID,
          parentWikiToken: parentToken,
          marker,
          creationStatus: "not-sent",
        };
        await this.save(input, intent);
        let creationError: unknown;
        let sent = false;
        try {
          await this.save(input, { ...intent, creationStatus: "uncertain" });
          await input.assertCurrent();
          await this.transport.request(
            "POST",
            `/wiki/v2/spaces/${encodeURIComponent(spaceID)}/nodes`,
            {
              obj_type: "docx",
              node_type: "origin",
              parent_node_token: parentToken,
              title: marker,
            },
            {
              retry: false,
              beforeSend: async () => {
                await input.assertCurrent();
                sent = true;
              },
            },
          );
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (
            !sent ||
            (status && [400, 401, 403, 404, 422, 429].includes(status))
          ) {
            await input.checkpoint(intent);
            throw error;
          }
          creationError = error;
        }
        // Even a successful transport retry may have created multiple nodes.
        matches = await this.findMarker(spaceID, parentToken, marker);
        if (!matches.length) {
          if (creationError) throw creationError;
          throw new Error("创建结果待核：未找到临时节点");
        }
      }
      if (matches.length !== 1) {
        throw new Error("存在多个同名临时阅读笔记，停止写入");
      }
      node = await this.getNode(required(matches[0].node_token, "临时节点"));
      this.validateNode(node, spaceID, parentToken);
      initializePending = true;
    }
    const nodeToken = required(node.node_token, "节点 token");
    const mapping: ReadingNotesMapping = {
      state: "ready",
      sourceKey: input.sourceKey,
      spaceID,
      parentWikiToken: parentToken,
      nodeToken,
      documentID: required(node.obj_token, "文档 ID"),
      wikiURL:
        input.remoteWikiURL ||
        (saved?.state === "ready"
          ? saved.wikiURL
          : wikiURL(input.parentWikiToken, nodeToken)),
      initializePending,
      clientToken: saved?.state === "ready" ? saved.clientToken : this.uuid(),
    };
    // Save identity before changing the recoverable temporary title.
    await this.save(input, mapping);
    if (node.title !== input.title) {
      await input.assertCurrent();
      await this.transport.request(
        "POST",
        `/wiki/v2/spaces/${encodeURIComponent(spaceID)}/nodes/${encodeURIComponent(nodeToken)}/update_title`,
        { title: input.title },
      );
    }
    if (mapping.initializePending) {
      await this.initialize(input, mapping);
      mapping.initializePending = false;
      await this.save(input, mapping);
    }
    await input.assertCurrent();
    return mapping;
  }

  private async initialize(
    input: ReadingNotesInput,
    mapping: ReadingNotesMapping,
  ) {
    const id = encodeURIComponent(mapping.documentID);
    const path = `/docx/v1/documents/${id}/blocks/${id}/children`;
    const hasBody = async () => {
      const data = await this.transport.request("GET", `${path}?page_size=50`);
      if (!Array.isArray(data.items))
        throw new Error("无法确认阅读笔记正文是否为空");
      // Any block, including an empty paragraph, belongs to the user.
      return data.items.length > 0 || data.has_more === true;
    };
    if (await hasBody()) return;
    const children = [
      textBlock(`来源key：${input.sourceKey}`),
      linkBlock("返回 Zotero", input.zoteroURL),
      linkBlock("返回表格", input.baseRecordURL),
      ...["研究问题", "方法", "结论", "阅读笔记"].map((title) =>
        textBlock(title, true),
      ),
    ];
    const append = async () => {
      await input.assertCurrent();
      await this.transport.request(
        "POST",
        `${path}?client_token=${encodeURIComponent(mapping.clientToken)}`,
        { children, index: -1 },
      );
    };
    try {
      await append();
    } catch {
      // A timed-out write may already have landed. Read before retrying and
      // reuse the persisted UUID if no body is visible yet.
      if (!(await hasBody())) await append();
    }
  }

  private async save(input: ReadingNotesInput, value: ReadingNotesCheckpoint) {
    await input.assertCurrent();
    await input.checkpoint({ ...value });
    await input.assertCurrent();
  }

  private async getNode(token: string): Promise<Node> {
    const data = await this.transport.request(
      "GET",
      `/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`,
    );
    if (!data.node || typeof data.node !== "object") {
      throw new Error("飞书未返回有效的 wiki 节点");
    }
    const node = data.node as Node;
    if (node.node_token !== token) throw new Error("飞书返回的节点身份不一致");
    return node;
  }

  private validateNode(node: Node, spaceID: string, parentToken: string) {
    if (
      node.obj_type !== "docx" ||
      node.space_id !== spaceID ||
      node.parent_node_token !== parentToken ||
      !node.obj_token ||
      (node.node_type !== undefined && node.node_type !== "origin")
    ) {
      throw new Error("阅读笔记不是目标父节点及空间下的原始 docx 文档");
    }
  }

  private async findMarker(
    spaceID: string,
    parentToken: string,
    marker: string,
  ) {
    const matches: Node[] = [];
    const seen = new Set<string>();
    let pageToken = "";
    do {
      const path = `/wiki/v2/spaces/${encodeURIComponent(spaceID)}/nodes?parent_node_token=${encodeURIComponent(parentToken)}`;
      const data = await this.transport.request(
        "GET",
        path +
          (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""),
      );
      if (!Array.isArray(data.items)) throw new Error("无法扫描阅读笔记父节点");
      for (const item of data.items as Node[]) {
        if (item.title === marker) matches.push(item);
      }
      if (!data.has_more) break;
      pageToken = required(data.page_token, "下一页 token");
      if (seen.has(pageToken)) throw new Error("阅读笔记分页 token 重复");
      seen.add(pageToken);
    } while (pageToken);
    return matches;
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`缺少${name}`);
  return value;
}

function wikiToken(value: string): string {
  if (!value.includes("://")) {
    if (!/^[\w-]+$/.test(value)) throw new Error("无效的 wiki token");
    return value;
  }
  const url = new URL(value);
  const match = /^\/wiki\/([\w-]+)\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    !match ||
    !(url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn"))
  )
    throw new Error("无效的 wiki 链接");
  return match[1];
}

function wikiURL(parent: string, token: string): string {
  const origin = parent.includes("://")
    ? new URL(parent).origin
    : "https://my.feishu.cn";
  return `${origin}/wiki/${encodeURIComponent(token)}`;
}

function textBlock(content: string, heading = false) {
  return {
    block_type: heading ? 4 : 2,
    [heading ? "heading2" : "text"]: {
      elements: [{ text_run: { content } }],
    },
  };
}

function linkBlock(content: string, url: string) {
  return {
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content,
            text_element_style: { link: { url } },
          },
        },
      ],
    },
  };
}

function randomUUID(): string {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      Number(c) ^
      (Math.floor(Math.random() * 256) & (15 >> (Number(c) / 4)))
    ).toString(16),
  );
}
