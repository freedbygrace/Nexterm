# 🔑 Host Enrollment

Enrollment turns adding a server into one command run on the server itself. Nexterm generates an SSH key
pair, keeps the private half, and hands you a command that grants it access on the target and creates the
connection for you.

```sh
# Linux, macOS, BSD
curl -fsSL https://nexterm.example/api/enroll/<token> | sh
```

```powershell
# Windows (OpenSSH server), from an elevated PowerShell
irm https://nexterm.example/api/enroll/<token>/ps1 | iex
```

You never type a password into Nexterm, and no private key ever leaves it.

## Key or certificate authority

A token grants access one of two ways:

| Method | On the host | When to use it |
| :-- | :-- | :-- |
| **Public key** | adds the token's key to the target user's `authorized_keys` | a handful of hosts, or no root access |
| **Certificate authority** | makes sshd trust Nexterm's SSH user CA (`TrustedUserCAKeys`) | fleets: one trust anchor, nothing per user |

With the certificate method, Nexterm signs a certificate **valid for ten minutes** for every connection,
for the identity's user name only. There is no long-lived certificate to leak, and nothing to clean out of
`authorized_keys` later. It needs root on the host, because it edits sshd's configuration; the Linux
command is shown with `sudo sh`. See [SSH certificates](./ssh-certificates.md) for how the CA works.

## Creating a token

**Settings → Enrollment → New token.** You choose:

| Option | Meaning |
| :-- | :-- |
| Access by | Public key, or certificate authority (see above) |
| Scope | Personal, or an organization (the key and the connections belong to it) |
| Target user | The account the key is installed for, `root` by default |
| Uses | Single use, a fixed number, or unlimited for a token you keep reusing |
| Lifetime | 1, 7 or 30 days, or never |
| Folder | Where enrolled connections are created |
| Create connections | Off if you only want the key installed |

The commands are shown **once**, when the token is created: Linux & macOS, Windows, cloud-init and
Cloudbase-init. The token itself is never displayed again; the list afterwards shows only the fingerprints
and how often it has been used.

## What the command does

The scripts are short and worth reading before piping anything into a shell. With a **public key**, the
Linux/macOS script:

1. finds the target user's home directory (`getent`, or `dscl` on macOS), refusing to install a key for
   another user unless it runs as root,
2. creates `~/.ssh` with mode 700 and `authorized_keys` with mode 600 if they are missing,
3. adds the public key **only if it is not already there**, comparing the key material rather than the whole
   line, so a hand-edited comment does not produce a duplicate,
4. reports the hostname, address, OS and SSH port back to Nexterm - and the RDP port when Remote Desktop
   is listening (xrdp on Linux, read from `/etc/xrdp/xrdp.ini`; on Windows when Remote Desktop is enabled).

With the **certificate authority**, it instead:

1. asks sshd for its effective `TrustedUserCAKeys` (`sshd -T`). sshd honours only the first one it reads,
   so an existing CA file is **extended**, never shadowed,
2. otherwise adds `TrustedUserCAKeys /etc/ssh/nexterm_user_ca.pub` - as a drop-in in `sshd_config.d`
   where the main config includes one (Debian, Ubuntu, Fedora), else before the first `Match` block,
3. adds the CA key to that file once,
4. checks the result with `sshd -t` and **restores the previous configuration** if sshd rejects it, then
   reloads sshd (systemd, service, OpenRC or a HUP; macOS needs none).

The Windows script does the same with OpenSSH for Windows: an administrator's key goes into
`C:\ProgramData\ssh\administrators_authorized_keys` when `sshd_config` says so (the default), files are
written without a byte-order mark and with the ACL sshd insists on, the CA line goes before the
`Match Group administrators` block, and sshd is restarted. It runs inside a script block, so an error never
closes your PowerShell window. It needs the OpenSSH server installed
(`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`) and an elevated prompt.

The connection gets SSH and SFTP, plus RDP when it was found. SSH stays the default protocol: the enrollment
key cannot log in over RDP, so Nexterm asks for Windows credentials the first time you connect with RDP
(or attach an identity to RDP on the entry).

Running any of them twice is safe. The second run says `already installed` / `already trusted` and updates
the existing connection rather than creating a second one. Protocols you added to that connection by hand, its default protocol and per-protocol
identities are kept; only what the script found is switched on or has its port updated.

Nothing secret is sent back: the payload is a hostname, an address, an OS string and a port, and Nexterm
rejects anything else.

## Cloud-init

A multi-use token is exactly what a machine image or an autoscaling group wants: every instance that boots
enrolls itself and appears in Nexterm with a working connection.

```yaml
#cloud-config
runcmd:
  - curl -fsSL https://nexterm.example/api/enroll/<token> | sh
```

Cloud-init runs `runcmd` as root late in boot, after the network is up, which is exactly what the script
needs. Two things are worth knowing:

- Give the token **unlimited uses** (or at least as many as you expect instances), otherwise the second
  instance fails.
- Instances of the same image often boot with the same hostname. Connections are matched by name, so
  identical hostnames collapse into one connection that keeps getting updated. Set a unique hostname in
  the same cloud-config, before the enrollment command, if you want one connection per instance.

The same command works from Terraform's `user_data`, an Ansible task, a Packer provisioner or a Dockerfile
entrypoint. It only needs `sh`, and `curl` or `wget`.

Windows images use Cloudbase-init the same way (it runs user data as LocalSystem):

```powershell
#ps1_sysnative
irm https://nexterm.example/api/enroll/<token>/ps1 | iex
```

## Security

The token in the URL is the only credential the target ever sees, so treat it like a password:

- It is 32 random bytes, and the enrollment endpoints are rate limited.
- It expires, counts its uses, and can be revoked at any time (see [Revoking access](#revoking-access)).
- It grants exactly two things: fetching the public key, and reporting a host. It cannot read anything
  from Nexterm.
- The private key is stored encrypted as an ordinary identity and is never served, not even to the host
  being enrolled.

Because the command is piped into a shell, anyone who can intercept it can run code as the target user.
Serve Nexterm over HTTPS, as you should anyway.

## Revoking access

The private key never leaves Nexterm, so Nexterm is where access is withdrawn. Revoking a token stops the
command from working *and* disables the identity it created: the public key stays in the host's
`authorized_keys`, but Nexterm refuses to use the private key, so every session, file transfer, jump host
and one-off command through that identity is rejected until it is enabled again.

- Enable or disable the key again on the enrollment page, or any identity on **SSH Keys & Credentials**.
- `DELETE /api/enrollment/:id?keepIdentity=true` revokes only the token, for the case where the command
  leaked but the hosts enrolled with it are fine.
- Deleting the identity is permanent and also removes it from every connection that used it.

Disabling is Nexterm's side of the door. To take the key off the host itself, remove the line from its
`authorized_keys` - the fingerprint shown on the token identifies it.

For certificate tokens, disabling the identity stops Nexterm signing certificates for it, and the last one
it signed expires within ten minutes. The CA stays trusted on the host, because other identities in the same
scope may rely on it; remove its line from the CA file to withdraw that trust too.

## API

```
POST   /api/enrollment       create a token (returns the secret and the command once)
GET    /api/enrollment       list tokens, without their secrets
DELETE /api/enrollment/:id   revoke a token and disable the key it installed
                             (?keepIdentity=true revokes the token only)
POST   /api/identities/:id/disabled  disable or enable an identity: {"disabled": true}
GET    /api/enroll/:token    the sh script (Linux, macOS, BSD), no login required
GET    /api/enroll/:token/ps1   the PowerShell script (Windows), no login required
POST   /api/enroll/:token/callback   report a host, no login required
GET    /api/identities/certificate-authority   the scope's CA public key (?organizationId=)
```

Creating a token:

```json
{
    "name": "web tier",
    "username": "root",
    "maxUses": null,
    "lifetimeDays": 30,
    "folderId": 4,
    "createEntries": true,
    "method": "certificate"
}
```

`maxUses: null` means unlimited, `lifetimeDays: null` means the token never expires, `method` is `key`
(the default) or `certificate`. The response carries `token`, `commands.unix`, `commands.windows`,
`publicKey` and `fingerprint` (plus `caPublicKey` and `caFingerprint` for certificate tokens);
`command` repeats `commands.unix` for older clients. The secret is never returned again.
