# SSH Client Certificates

Nexterm can authenticate with SSH user certificates in two ways: with a certificate **you** supply, signed by
your own CA, or with certificates **Nexterm signs itself**, fresh for every connection.

## Nexterm's certificate authority

Every personal space and organization has an ed25519 SSH user CA, created the first time something needs it
and stored encrypted like any credential. Hosts that trust its public key accept any identity linked to it:

- **Link an identity**: in the identity dialog, turn on *Sign with the certificate authority* (RSA keys).
- **Enroll hosts**: create an enrollment token with *Access by: Certificate authority*; its command makes sshd
  trust the CA on Linux, macOS and Windows (see [Host enrollment](./enrollment.md)).
- **Install it yourself**: *Settings → Enrollment* shows the CA and copies its public key - add it to the
  file named by `TrustedUserCAKeys` in `sshd_config` (Ansible, a golden image, ...).

For every connection, Nexterm signs a certificate for the identity's key that is:

| Field | Value |
| :-- | :-- |
| Principals | the identity's user name only |
| Valid | from 5 minutes ago (clock skew) to 10 minutes from now |
| Key ID | `nexterm identity <id>` - what sshd logs on login |
| Extensions | pty, agent/port/X11 forwarding, user rc (ssh-keygen's defaults) |

sshd checks a certificate only when a session starts, so sessions outlive it; a reconnect gets a new one.
Nothing long-lived exists to leak, and **disabling the identity stops access immediately**: Nexterm refuses
to sign for it, and its last certificate expires within minutes.

Keep in mind what trusting a CA means: a host that trusts the organization's CA accepts a certificate for
*any* identity in that organization whose user name exists on the host. Use separate organizations, or
per-host `AuthorizedPrincipalsFile`, where that is too broad.

## Your own certificates

An OpenSSH user certificate paired with its matching private key. The certificate is uploaded separately from the private key and is used as a companion to it; the existing SSH key and password authentication modes remain unchanged.

Certificates are available for:

- saved identities;
- Quick Connect;
- SSH configuration import via `CertificateFile`; and
- SSH connections that use jump hosts, SFTP, tunnels, command execution, or monitoring.

The certificate file should contain the OpenSSH public certificate, usually a line beginning with an algorithm such as `ssh-ed25519-cert-v01@openssh.com`. It must correspond to the private key supplied in the same identity. Passphrases continue to apply to the private key.

Both the key and the certificate can be uploaded as a file or pasted as text; the dialog warns when what it
was given does not look right (a public key where the private key belongs, a PuTTY key, a key in the
certificate field). An identity linked to Nexterm's CA ignores an uploaded certificate.

Credential material is encrypted with Nexterm's normal credential storage before it is persisted. The certificate itself is public-key material, but it should still be treated as part of the identity configuration and rotated with the private key when its signing authority or validity period changes.

## Runtime compatibility

This feature does not change or pin the bundled libssh2 dependency version. The engine runtime must provide the libssh2 public-key authentication API with support for passing an OpenSSH certificate alongside the private key. When deploying a custom or older engine image, verify its libssh2 build supports SSH user certificates before relying on this authentication mode.
