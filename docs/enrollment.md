# 🔑 Host Enrollment

Enrollment turns adding a server into one command run on the server itself. Nexterm generates an SSH key
pair, keeps the private half, and hands you a command that installs the public half on the target and
creates the connection for you.

```
curl -fsSL https://nexterm.example/api/enroll/<token> | sh
```

You never type a password into Nexterm, and no private key ever leaves it.

## Creating a token

**Settings → Enrollment → New token.** You choose:

| Option | Meaning |
| :-- | :-- |
| Scope | Personal, or an organization (the key and the connections belong to it) |
| Target user | The account the key is installed for, `root` by default |
| Uses | Single use, a fixed number, or unlimited for a token you keep reusing |
| Lifetime | 1, 7 or 30 days, or never |
| Folder | Where enrolled connections are created |
| Create connections | Off if you only want the key installed |

The command is shown **once**, when the token is created. The token itself is never displayed again;
the list afterwards shows only the public key, its fingerprint, and how often it has been used.

## What the command does

The script is short and worth reading before piping anything into a shell. In order, it:

1. finds the target user's home directory, refusing to install a key for another user unless it runs as root,
2. creates `~/.ssh` with mode 700 and `authorized_keys` with mode 600 if they are missing,
3. adds the public key **only if it is not already there**, comparing the key material rather than the whole
   line, so a hand-edited comment does not produce a duplicate,
4. reports the hostname, address, OS and SSH port back to Nexterm.

Running it twice is safe. The second run says `key already installed` and updates the existing connection
rather than creating a second one.

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

## API

```
POST   /api/enrollment       create a token (returns the secret and the command once)
GET    /api/enrollment       list tokens, without their secrets
DELETE /api/enrollment/:id   revoke a token and disable the key it installed
                             (?keepIdentity=true revokes the token only)
POST   /api/identities/:id/disabled  disable or enable an identity: {"disabled": true}
GET    /api/enroll/:token    the shell script, no login required
POST   /api/enroll/:token/callback   report a host, no login required
```

Creating a token:

```json
{
    "name": "web tier",
    "username": "root",
    "maxUses": null,
    "lifetimeDays": 30,
    "folderId": 4,
    "createEntries": true
}
```

`maxUses: null` means unlimited, `lifetimeDays: null` means the token never expires. The response carries
`token`, `command`, `publicKey` and `fingerprint`; the secret is never returned again.
