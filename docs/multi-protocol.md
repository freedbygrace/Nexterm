# 🔌 Multi-Protocol Connections

A server entry describes one host and can expose several protocols at the same time. Instead of creating an SSH
entry, an RDP entry and an SFTP entry for the same machine, you create one connection and enable the protocols it
offers.

## Enabling protocols

Open the server dialog and use the **Protocols** list on the details tab:

- **Toggle** each protocol the host offers: SSH, SFTP, Telnet, RDP, VNC, FTP or FTPS.
- **Port** is configured per protocol. Enabling SSH also enables SFTP on the same port; you can disable it or give
  it a different port.
- **Primary** marks the protocol used by the default *Connect* action, by the mobile app and by the CLI. The tab
  icon and the list badge follow the primary protocol.

Identities are shared by all protocols of the entry. The identity tab shows the authentication types that make sense
for the enabled protocols (for example SSH keys are only offered while SSH or SFTP is enabled), and the settings tab
shows the union of the protocol-specific settings (RDP display options, telnet auto-login, jump hosts, ...).

## Connecting

Right-click an entry:

- **Connect** opens the primary protocol.
- **Connect via RDP / VNC / Telnet / FTP ...** appears for every other enabled protocol.
- **Open SFTP**, **Open Browser**, **Forward Port** and **Run Script** are available whenever the entry exposes SFTP
  or SSH, regardless of which protocol is primary.
- **Quick Connect** lets you pick the protocol together with one-off credentials.

Every session remembers the protocol it was opened with, so hibernated and reconnected sessions keep their renderer.

## API

Entries carry a `config.protocols` map next to the legacy `config.protocol` (primary) and `config.port` (primary port),
which stay in sync:

```json
{
  "name": "build-box",
  "type": "server",
  "config": {
    "ip": "10.0.0.5",
    "protocol": "ssh",
    "port": 22,
    "protocols": {
      "ssh":  { "enabled": true,  "port": 22 },
      "sftp": { "enabled": true,  "port": 22 },
      "rdp":  { "enabled": true,  "port": 3389 },
      "vnc":  { "enabled": false, "port": 5900 }
    }
  }
}
```

`GET /api/entries/list` returns the enabled protocols as `protocols` (primary first). To open a session over a
specific protocol, pass it in the `type` field of `POST /api/connections` (`ssh`, `telnet`, `rdp`, `vnc`, `sftp`,
`ftp`, `ftps`, or `web` for the remote browser); omitting `type` uses the primary protocol. Requests for a protocol that
is not enabled on the entry are rejected.

### Folders from scripts

Instead of looking up a `folderId`, pass `folderPath` when creating or updating an entry:

```json
{ "name": "build-box", "type": "server", "folderPath": "Prod/Web/EU", "config": { "...": "..." } }
```

Each level is matched case-insensitively among the existing folders of the same scope (your personal
list, or the organization given by `organizationId` / an explicit `folderId` to start from) and is only created when
missing, so running the same import twice never produces duplicate folders. An array of names works as well
(`["Prod", "Web", "EU"]`) if a folder name contains a slash. `PUT /api/folders` follows the same rule and returns the
existing folder when a sibling with the same name already exists.

Existing entries are migrated automatically: each one gets a map containing its previous protocol (plus SFTP for SSH
entries), so nothing changes until you enable more.
