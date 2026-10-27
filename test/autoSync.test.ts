import { assert } from "chai";
import { config } from "../package.json";
import { getPref, setPref } from "../src/utils/prefs";

describe("automatic Base synchronization", function () {
  this.timeout(15_000);

  it("coalesces edits and syncs a changed child through its parent", async function () {
    const plugin = Zotero[config.addonInstance] as any;
    const saved = {
      autoSync: getPref("autoSync"),
      targetBase: getPref("targetBase"),
      targetTable: getPref("targetTable"),
      authorized: plugin.sync.oauth.isAuthorized,
      syncItems: plugin.sync.syncItems,
    };
    const batches: string[][] = [];
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Automatic sync test");
    await parent.saveTx();
    const note = new Zotero.Item("note");
    note.parentID = parent.id;
    note.setNote("Example note");
    await note.saveTx();
    const unrelated = new Zotero.Item("journalArticle");
    unrelated.setField("title", "Unrelated item must not sync for tag edits");
    await unrelated.saveTx();
    const collection = new Zotero.Collection();
    collection.name = "Automatic classification test";
    await collection.saveTx();
    const childCollection = new Zotero.Collection();
    childCollection.name = "Child classification";
    childCollection.parentID = collection.id;
    await childCollection.saveTx();
    try {
      setPref("autoSync", true);
      setPref("targetBase", "test-base");
      setPref("targetTable", "test-table");
      plugin.sync.oauth.isAuthorized = () => true;
      plugin.sync.syncItems = async (items: Zotero.Item[]) => {
        batches.push(items.map((item) => item.key));
        return [];
      };
      await Zotero.Notifier.trigger("modify", "item", [parent.id]);
      await Zotero.Notifier.trigger("modify", "item", [note.id]);
      await Zotero.Notifier.trigger("modify", "item-tag", [`${parent.id}-123`]);
      await Zotero.Promise.delay(2300);
      assert.deepEqual(batches, [[parent.key]]);

      await childCollection.eraseTx();
      await Zotero.Promise.delay(2300);
      assert.lengthOf(batches, 2);
      assert.includeMembers(batches[1], [parent.key, unrelated.key]);

      setPref("autoSync", false);
      await Zotero.Notifier.trigger("modify", "item", [parent.id]);
      await Zotero.Promise.delay(2300);
      assert.lengthOf(batches, 2);
    } finally {
      setPref("autoSync", saved.autoSync);
      setPref("targetBase", saved.targetBase);
      setPref("targetTable", saved.targetTable);
      plugin.sync.oauth.isAuthorized = saved.authorized;
      plugin.sync.syncItems = saved.syncItems;
      await parent.eraseTx();
      await unrelated.eraseTx();
      await collection.eraseTx();
    }
  });
});
