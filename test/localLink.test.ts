import { assert } from "chai";
import { OpenItemEndpoint, localItemLink } from "../src/modules/localLink";

describe("local Zotero item links", function () {
  const headers = {
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };

  it("uses a browser-compatible loopback URL", function () {
    assert.match(
      localItemLink("ABCDEFGH").link,
      /^http:\/\/127\.0\.0\.1:\d+\/zotero-feishu\/open\?itemKey=ABCDEFGH$/,
    );
  });

  it("rejects fetches, iframes, and non-user navigation", async function () {
    const endpoint = new OpenItemEndpoint();
    for (const denied of [
      {},
      { ...headers, "sec-fetch-dest": "iframe" },
      { ...headers, "sec-fetch-user": "" },
    ]) {
      const result = await endpoint.init({
        searchParams: new URLSearchParams("itemKey=ABCDEFGH"),
        headers: denied,
      });
      assert.equal(result[0], 403);
    }
  });

  it("rejects malformed and unknown item keys", async function () {
    const endpoint = new OpenItemEndpoint();
    assert.equal(
      (
        await endpoint.init({
          searchParams: new URLSearchParams("itemKey=../prefs"),
          headers,
        })
      )[0],
      400,
    );
    assert.equal(
      (
        await endpoint.init({
          searchParams: new URLSearchParams("itemKey=00000000"),
          headers,
        })
      )[0],
      404,
    );
  });

  it("selects an existing item without changing its content", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Local link test");
    await item.saveTx();
    try {
      const result = await new OpenItemEndpoint().init({
        searchParams: new URLSearchParams(`itemKey=${item.key}`),
        headers,
      });
      assert.equal(result[0], 200);
      assert.equal(
        Zotero.getMainWindow().ZoteroPane.getSelectedItems()[0]?.key,
        item.key,
      );
      assert.equal(item.getField("title"), "Local link test");
    } finally {
      await item.eraseTx();
    }
  });
});
