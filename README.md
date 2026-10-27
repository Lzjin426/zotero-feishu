# Zotero Feishu Sync

> Local adaptation, version 0.7.1-fullstop.1, based on
> [wu-uk/zotero-feishu](https://github.com/wu-uk/zotero-feishu) v0.7.0.
> Adds Feishu Base synchronization and Zotero 10 support. This adaptation is
> distributed with its complete source under the original AGPL-3.0-or-later license.

[简体中文](doc/README-zhCN.md)

## Base synchronization in this adaptation

Build this adaptation from [this fork](https://github.com/Lzjin426/zotero-feishu):
run `npm ci` and `npm run build`, then install
`.scaffold/build/zotero-feishu-sync.xpi` in Zotero. Upstream releases do not contain
this adaptation's Base support. In Zotero
Settings → Zotero Feishu Sync, enter the Base URL and table ID, connect Feishu,
and enable automatic synchronization and PDF uploads. New and modified items in
My Library synchronize while Zotero is running. Startup catches up the existing
personal library. Right-click items or a collection for manual synchronization.

The Base schema uses Chinese field names configured for the literature library.
Create the following fields with these exact names before connecting:

| Field           | Feishu field type                                 |
| --------------- | ------------------------------------------------- |
| 文献标题        | Text (primary field)                              |
| 作者            | Text                                              |
| 年份            | Number or text                                    |
| 期刊或会议      | Text                                              |
| 摘要            | Text                                              |
| DOI             | URL                                               |
| 原文链接        | URL                                               |
| Zotero 条目链接 | URL                                               |
| Zotero 分类     | Text                                              |
| Zotero 标签     | Text                                              |
| Zotero 唯一标识 | Text                                              |
| 最近同步时间    | Date, with time                                   |
| PDF 附件        | Attachment, required when PDF uploads are enabled |

Open the target data table in Feishu. A link shaped like
`https://example.feishu.cn/base/BASE_TOKEN?table=tblTABLE_ID&view=VIEW_ID`
contains the Base URL (`https://example.feishu.cn/base/BASE_TOKEN`) and the
table ID (`tblTABLE_ID`). Use a `/base/` link; `/wiki/` links must first be resolved
to the underlying Base. Reading-management fields can be added independently.

Bibliographic fields and locally available PDFs come from Zotero. Reading status,
priority, research questions, findings, limitations, and reading notes remain
owned by the reader and are never overwritten by synchronization. No reverse
synchronization or automatic deletion of remote records is performed. Updates to
PDF contents append a new attachment while preserving existing files.

Without a Zotero cloud account, the item link opens the source item through a
navigation-only loopback endpoint in this plugin. It requires Zotero to be running
on the same computer. Feishu record links do not require a separate synchronization
server. Cloud credentials remain in Zotero's Firefox Login Manager, and synchronization
state remains in the Zotero profile. This local build intentionally omits the
upstream automatic update URL so an upstream update cannot remove Base support.

Base mode requests only `bitable:app`, `docs:document.media:upload`, and
`offline_access`. Switching to the original document mode requires reconnecting
to grant that mode's permissions.

The following sections describe the original document synchronization mode.

Zotero Feishu Sync is an unofficial Zotero plugin that publishes literature
metadata, notes, images, and PDF attachments to Feishu cloud documents. Zotero
remains the source of truth: synchronizing an existing item replaces the
plugin-managed content in its mapped Feishu document.

## Requirements

- The upstream plugin supports Zotero 8–9; this adaptation is tested on Zotero 10.0.6.
- A mainland Feishu account that can create a personal application and grant
  the requested permissions. Tenant policy may require administrator approval.
- Local PDF and note-image files must be available to Zotero when synchronizing.

## Installation

1. For this adaptation, build the XPI as described above. The original document-only
   plugin is available from the [upstream releases](https://github.com/wu-uk/zotero-feishu/releases).
2. In Zotero, open **Tools → Plugins**.
3. Choose **Install Add-on From File**, select the XPI, and restart Zotero if
   requested.

## Connect Feishu

1. Open **Zotero Settings → Zotero Feishu Sync** and select **Connect Feishu**.
2. Confirm creation of the dedicated personal application in the browser.
3. If the Feishu permission console opens, enable the listed permissions and
   complete any required app publication or administrator approval.
4. Complete account authorization in the browser and return to Zotero.

No App ID, App Secret, or redirect URL needs to be entered manually. Leave the
target folder empty to use the root of My Space, or enter a Feishu Drive folder
URL or token.

## Usage

- Right-click a regular Zotero item, child note, or child attachment and choose
  **Feishu Sync → Sync selected items**.
- Right-click a collection and choose **Sync current collection to Feishu**.
- Use the same item menu to open or explicitly delete its mapped document.
- Check the Feishu status column for syncing, success, or failure details.

Each regular item maps to one Feishu Docx. Unchanged sources are skipped after
the mapped document is verified. Child notes retain Markdown-equivalent
structure, embedded note images are uploaded, and local child PDFs are appended
to the document.

## Limitations

- Only My Library and mainland Feishu are currently supported.
- Standalone notes and standalone attachments are not synchronized. Selecting a
  child note or attachment synchronizes its regular parent item.
- PDF annotations must first be added to a Zotero note.
- Feishu edits are not imported into Zotero and may be replaced by the next
  synchronization.
- Item mappings are local to the Zotero profile. Losing the mapping can create a
  second Feishu document for the same item.

## Privacy And Removal

Literature content is sent directly from Zotero to Feishu; the plugin does not
use a developer-operated relay server. App credentials and OAuth tokens are
stored in Zotero's Firefox Login Manager. Item mappings are stored in
`<Zotero profile>/zotero-feishu/state.json`.

Disconnecting removes the OAuth tokens but retains the generated application
credentials for a later reconnect. Uninstalling the plugin does not delete the
personal application or synchronized documents from Feishu; remove them from
the Feishu Open Platform and Drive when they are no longer needed.

## Development

```bash
npm install
npm start
npm run lint:check
npm run build
npm test
```

Copy `.env.example` to `.env` and use a dedicated Zotero development profile.
Production packages and update manifests are written to `.scaffold/build/`.

## License

AGPL-3.0-or-later. See `THIRD_PARTY_NOTICES.md` for incorporated third-party
software notices. Feishu and its logo are trademarks of their respective owner;
this project is not affiliated with or endorsed by Feishu.
