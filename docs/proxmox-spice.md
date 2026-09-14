# 🌶️ Proxmox SPICE Consoles

Nexterm can open the SPICE console of a Proxmox VE QEMU virtual machine, and can connect to a plain SPICE
server the same way it connects to VNC or RDP. SPICE gives a QEMU guest a smoother desktop than VNC does:
hardware cursor, audio playback and a proper clipboard channel.

## Requirements

SPICE is rendered by a Guacamole protocol plugin (`libguac-client-spice`) that the Nexterm engine loads at
connect time, so support lives entirely in the engine:

- The engine image must have been built with **spice-gtk** available (`spice-client-glib-2.0` and
  `spice-protocol` at build time, the `spice-gtk` runtime library in the image). The official engine images
  ship it; a self-built engine on a distribution without those packages simply has no SPICE plugin, and
  opening a SPICE session fails with an "unsupported protocol" error from the engine.
- The engine — not your browser — makes the outbound connection. For a Proxmox console it must be able to
  reach the **SPICE proxy** of the cluster (TCP **3128** on the Proxmox node) and, through it, the **TLS port**
  Proxmox assigns the VM (typically 61000 and up).
- Jump hosts are not used for Proxmox SPICE consoles: the hostname Proxmox returns is a routing token rather
  than an address, so there is nothing to tunnel. Give the engine direct access to the cluster instead. Plain
  SPICE entries do support jump hosts.

## How the Proxmox console works

Proxmox does not expose the VM's SPICE port directly. Opening the console is a broker flow:

1. Nexterm authenticates against the Proxmox API and calls
   `POST /api2/json/nodes/{node}/qemu/{vmid}/spiceproxy`.
2. Proxmox answers with an opaque `host` token (`pvespiceproxy:…`), the `proxy` to connect through
   (`http://node.example.com:3128`), a `tls-port`, a single-use `password` ticket, the cluster `ca`
   certificate and the `host-subject` its node certificate presents.
3. The engine connects to the proxy, which routes the TLS SPICE session to the VM using the token.

The ticket is **single-use and expires in about 30 seconds**, so Nexterm requests it immediately before
opening the session rather than when the entry is created or listed. A console that fails to open can simply
be retried; each attempt brokers a fresh ticket.

### Certificates

Proxmox signs node certificates with the cluster's own (self-signed) CA, which no public trust store knows.
Nexterm therefore verifies the SPICE endpoint against exactly what the broker hands back: the cluster CA is
passed to the plugin as inline PEM, and the returned host subject is the expected certificate subject. If a
cluster returns neither, verification is disabled for that connection — there would be nothing to verify
against.

Nothing needs to be installed on the engine host: the CA travels with the ticket.

## Switching a VM to SPICE

Proxmox VMs appear under their Proxmox integration in the server list. To use SPICE for one:

1. Make sure the VM's display is a SPICE device in Proxmox (**Hardware → Display → SPICE (qxl)**). A VM with
   the default VGA display has no SPICE server to connect to.
2. Right-click the VM in Nexterm and choose **Edit**.
3. On the **Settings** tab set **Console Type** to **SPICE** and save.

The next *Connect* opens the SPICE console; switching back to **VNC** restores the previous behaviour. The
setting is per VM and is stored as `config.consoleType` (`"vnc"` or `"spice"`), so it can also be set through
the API.

For the best experience install the guest agent and SPICE guest tools inside the VM (`spice-vdagent` on
Linux, the SPICE guest tools on Windows). Without them the guest has no clipboard channel and no dynamic
resolution.

## Plain SPICE servers

A SPICE server that is not behind Proxmox — a libvirt/QEMU host, for example — is a normal server entry:
enable **SPICE** in the entry's protocol list (default port **5900**) and give it an identity. SPICE
authenticates with a ticket rather than a user account, so a *password only* identity is the usual choice.
Display and audio settings work as they do for VNC, and jump hosts are supported.

See [Multi-Protocol Connections](/multi-protocol) for how protocols are enabled on an entry.
