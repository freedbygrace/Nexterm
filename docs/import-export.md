# 📦 Import & Export

Server entries can be exported to a JSON document and imported back, on the same installation or a different
one. The two use the same format, so an export can be edited by hand and fed straight back in.

## Exporting

Right-click a folder, an organization or empty space in the server list and choose **Export entries**. The
download contains the folder (and its subfolders), the organization, or everything you can see.

The document is formatted GNU style: every brace on its own line, one value per line, four-space indent, so
it reads and diffs well and is easy to edit.

```json
{
    "version": 1,
    "exportedAt": "2026-09-13T21:14:52.301Z",
    "entries":
    [
        {
            "name": "build-box",
            "host": "10.0.0.5",
            "folderPath": "Prod/Web/EU",
            "protocols":
            {
                "ssh":
                {
                    "enabled": true,
                    "port": 22
                },
                "sftp":
                {
                    "enabled": true,
                    "port": 22
                },
                "rdp":
                {
                    "enabled": true,
                    "port": 3389,
                    "identity": "win-admin"
                }
            },
            "primary": "ssh",
            "identities":
            [
                "root",
                "win-admin"
            ],
            "tags":
            [
                "prod"
            ],
            "description": "build agent",
            "notes": "# Runbook\n\nRestart with `systemctl restart buildd`.",
            "icon": "server",
            "monitoring": true,
            "config":
            {
                "rdpSecurity": "nla",
                "jumpHosts":
                [
                    "bastion"
                ]
            }
        }
    ]
}
```

| Field | Meaning |
| :-- | :-- |
| `name`, `host` | entry name and IP or hostname |
| `folderPath` | folder below the export scope; created on import when missing |
| `protocols` | one entry per enabled protocol with its `port` and optional per-protocol `identity` |
| `primary` | protocol used by the default Connect action |
| `identities` | identities linked to the entry, **by name** |
| `tags` | tag names; missing tags are created on import |
| `description` | one-line blurb; shown under the entry name in the list |
| `notes` | free-form Markdown, kept in the entry's notes panel |
| `config` | everything else: RDP security, keyboard layout, jump hosts (by entry name), Wake-on-LAN, telnet prompts, display options |

**Secrets are never exported.** Identities are referenced by name only; passwords, keys and certificates stay
in the installation. Importing into a fresh installation therefore needs identities with matching names to
exist first. Proxmox entries are skipped: they are synced from their integration, not imported.

## Importing

Right-click a folder or empty space and choose **Import → Entries (JSON)**. Paste the document or choose a
file, press **Check** for a dry run that resolves folders and identities without writing anything, then
**Import**.

An entry whose name already exists in its target folder is skipped, so re-importing a document is safe.
A row that cannot be resolved (unknown identity, invalid protocol) is reported on its own and never aborts
the rest of the import.

## API

```
GET  /api/entries/export?folderId=&organizationId=
POST /api/entries/import/bulk
```

The import accepts the export document as-is, or `{ "entries": [ ... ] }`, plus:

| Field | Default | Meaning |
| :-- | :-- | :-- |
| `folderId` | none | import below this folder |
| `organizationId` | personal | import into this organization |
| `dryRun` | `false` | validate and resolve only, write nothing |
| `updateExisting` | `false` | patch entries that already exist instead of skipping them |

`protocols` may also be a plain list (`["ssh", "rdp"]`) which uses the default ports, and `identities` may
contain numeric ids instead of names. The response reports per-row results:

```json
{
    "message": "Bulk import: 2 created, 0 updated, 1 skipped, 0 errors",
    "total": 3,
    "created": 2,
    "skipped": 1,
    "errors": 0,
    "results": [ { "index": 0, "name": "build-box", "status": "created", "id": 12 } ]
}
```

See [Multi-Protocol Connections](/multi-protocol) for the protocol model itself.
