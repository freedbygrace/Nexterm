# 🔌 Multi-Protocol Connections

A server entry describes one host and can expose several protocols at the same time. Instead of creating an SSH
entry, an RDP entry and an SFTP entry for the same machine, you create one connection and enable the protocols it
offers.

## Enabling protocols

Open the server dialog and use the **Protocols** list on the details tab:

- **Toggle** each protocol the host offers: SSH, SFTP, Telnet, RDP, VNC, SPICE, FTP or FTPS.
- **Port** is configured per protocol. Enabling SSH also enables SFTP on the same port; you can disable it or give
  it a different port.
- **Primary** marks the protocol used by the default *Connect* action, by the mobile app and by the CLI. The tab
  icon and the list badge follow the primary protocol.

Identities are shared by all protocols of the entry. The identity tab shows the authentication types that make sense
for the enabled protocols (for example SSH keys are only offered while SSH or SFTP is enabled), and the settings tab
shows the union of the protocol-specific settings (RDP display options, telnet auto-login, jump hosts, ...).

When an entry links two or more identities, the protocol list gains an **Identity** column: pick, for example, the
Windows account for RDP and keep the entry default (the first linked identity) for SSH. The chosen identity is used
whenever that protocol is opened without picking one explicitly. In the API this is `identityId` inside the protocol
entry (`"rdp": { "enabled": true, "port": 3389, "identityId": 12 }`); the list endpoint reports the mapping as
`protocolIdentities`.

## Connecting

Right-click an entry:

- **Connect** opens the primary protocol.
- **Connect via RDP / VNC / SPICE / Telnet / FTP ...** appears for every other enabled protocol.
- **Open SFTP**, **Open Browser**, **Forward Port** and **Run Script** are available whenever the entry exposes SFTP
  or SSH, regardless of which protocol is primary.
- **Quick Connect** lets you pick the protocol together with one-off credentials.

Every session remembers the protocol it was opened with, so hibernated and reconnected sessions keep their renderer.

## Reachability

The status checker probes the port of every enabled protocol through the engine (a plain TCP connect, no login).
Protocols that share a port are probed once, so SFTP simply follows SSH. The result is shown in the server list:

- Multi-protocol entries colour their protocol chips: accent for reachable, dimmed and struck through for
  unreachable, neutral while not checked yet. Hovering a chip shows e.g. `RDP: online (checked 2 min ago)`.
- Single-protocol entries keep the grey icon when offline and get a small green/red dot.
- The entry counts as online as soon as one protocol answers.

Two switches control the checks:

- **Settings → Monitoring → Enable Status Checker** turns the checker on or off globally (and sets the interval).
- **Server dialog → Settings → Reachability checks** excludes a single entry (`config.statusCheckEnabled: false`
  in the API); its status is cleared instead of being shown as offline.

Checks only run while an engine is connected. `GET /api/entries/list` reports the last result as
`statusDetails: { "checkedAt": "…", "protocols": { "ssh": "online", "rdp": "offline" } }` (`null` when unknown).

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
      "vnc":  { "enabled": false, "port": 5900 },
      "spice": { "enabled": false, "port": 5900 }
    }
  }
}
```

`GET /api/entries/list` returns the enabled protocols as `protocols` (primary first). To open a session over a
specific protocol, pass it in the `type` field of `POST /api/connections` (`ssh`, `telnet`, `rdp`, `vnc`, `spice`,
`sftp`, `ftp`, `ftps`, or `web` for the remote browser); omitting `type` uses the primary protocol. Requests for a
protocol that is not enabled on the entry are rejected.

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

Entries can also be exported and re-imported as JSON, including their protocol map and per-protocol
identities; see [Import & Export](/import-export).

Existing entries are migrated automatically: each one gets a map containing its previous protocol (plus SFTP for SSH
entries), so nothing changes until you enable more.

## Uploads

Files are uploaded three at a time. Anything larger than 8 MB is sent in 4 MB chunks, so a slow transfer
cannot run into the request timeout; each chunk is retried up to three times, and if a connection drops
mid-file the upload resumes from the byte the server already holds instead of starting again. Unfinished
uploads live next to the destination as `<name>.<id>.nexterm-part` and are removed when the upload is
cancelled or fails.

The status pill in the bottom right corner shows how many files are left and cancels the whole queue.

## Copying the current path

The file manager can copy a remote path to the clipboard: **Copy path** in an item's context menu (one path
per line for a multi-selection), **Copy current path** in the empty-space menu, and a button next to the
breadcrumb.

In an SSH session the same action appears in the terminal context menu, but only once the shell has told
Nexterm where it is. Shells do that with the OSC 7 escape sequence. zsh and fish emit it out of the box on
most distributions (through `vte.sh` / `__vte_prompt_command`); for bash add this to `~/.bashrc`:

```bash
PROMPT_COMMAND='printf "\033]7;file://%s%s\007" "$HOSTNAME" "$PWD"'
```
