const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    PROTOCOLS,
    getProtocolMap,
    getEnabledProtocols,
    isProtocolEnabled,
    getPrimaryProtocol,
    getProtocolPort,
    getProtocolIdentityId,
    getProtocolIdentities,
    resolveSessionProtocol,
    getRendererForProtocol,
    normalizeServerConfig,
} = require("./entryProtocols");

const serverEntry = (config) => ({ type: "server", config });

describe("legacy single-protocol entries", () => {
    it("treats the primary protocol as enabled", () => {
        const entry = serverEntry({ protocol: "rdp", port: "3390", ip: "10.0.0.1" });
        assert.deepEqual(getEnabledProtocols(entry), ["rdp"]);
        assert.equal(isProtocolEnabled(entry, "rdp"), true);
        assert.equal(isProtocolEnabled(entry, "ssh"), false);
        assert.equal(getProtocolPort(entry, "rdp"), 3390);
    });

    it("implies SFTP on SSH entries and shares the SSH port", () => {
        const entry = serverEntry({ protocol: "ssh", port: 2222 });
        assert.deepEqual(getEnabledProtocols(entry), ["ssh", "sftp"]);
        assert.equal(getProtocolPort(entry, "sftp"), 2222);
    });

    it("falls back to the default port when none is configured", () => {
        assert.equal(getProtocolPort(serverEntry({ protocol: "vnc" }), "vnc"), 5900);
    });
});

describe("multi-protocol entries", () => {
    const entry = serverEntry({
        protocol: "ssh",
        port: 22,
        protocols: {
            ssh: { enabled: true, port: 22 },
            rdp: { enabled: true, port: "3390", identityId: 7 },
            vnc: { enabled: false, port: 5900 },
            sftp: { enabled: false },
        },
    });

    it("lists the enabled protocols with the primary first", () => {
        assert.deepEqual(getEnabledProtocols(entry), ["ssh", "rdp"]);
    });

    it("keeps per-protocol ports apart", () => {
        assert.equal(getProtocolPort(entry, "ssh"), 22);
        assert.equal(getProtocolPort(entry, "rdp"), 3390);
    });

    it("honours an explicitly disabled SFTP", () => {
        assert.equal(isProtocolEnabled(entry, "sftp"), false);
    });

    it("exposes per-protocol identities", () => {
        assert.equal(getProtocolIdentityId(entry, "rdp"), 7);
        assert.equal(getProtocolIdentityId(entry, "ssh"), null);
        assert.deepEqual(getProtocolIdentities(entry), { rdp: 7 });
    });

    it("ignores identities of disabled protocols", () => {
        const disabled = serverEntry({ protocol: "ssh", protocols: { ssh: { enabled: true }, rdp: { enabled: false, identityId: 9 } } });
        assert.deepEqual(getProtocolIdentities(disabled), {});
    });
});

describe("normalizeServerConfig", () => {
    it("mirrors the primary protocol and its port", () => {
        const config = normalizeServerConfig({ protocol: "rdp", protocols: { ssh: { enabled: true, port: 22 }, rdp: { enabled: true, port: 3389 } } });
        assert.equal(config.protocol, "rdp");
        assert.equal(config.port, 3389);
    });

    it("falls back to the first enabled protocol when the primary is disabled", () => {
        const config = normalizeServerConfig({ protocol: "rdp", protocols: { ssh: { enabled: true, port: 22 }, rdp: { enabled: false, port: 3389 } } });
        assert.equal(config.protocol, "ssh");
        assert.equal(config.port, 22);
    });

    it("never leaves an entry without a usable protocol", () => {
        const config = normalizeServerConfig({ protocol: "ssh", port: 22, protocols: { ssh: { enabled: false }, rdp: { enabled: false } } });
        assert.equal(config.protocol, "ssh");
        assert.equal(config.protocols.ssh.enabled, true);
    });

    it("expands a legacy config into a map", () => {
        const config = normalizeServerConfig({ protocol: "ssh", port: "2222" });
        assert.deepEqual(config.protocols.ssh, { enabled: true, port: 2222 });
        assert.deepEqual(config.protocols.sftp, { enabled: true, port: 2222 });
    });

    it("keeps per-protocol identities and coerces ports to numbers", () => {
        const config = normalizeServerConfig({ protocol: "ssh", protocols: { ssh: { enabled: true, port: "22" }, rdp: { enabled: true, port: "3390", identityId: "7" } } });
        assert.deepEqual(config.protocols.rdp, { enabled: true, port: 3390, identityId: 7 });
    });

    it("is idempotent", () => {
        const once = normalizeServerConfig({ protocol: "ssh", port: 22 });
        const twice = normalizeServerConfig({ ...once });
        assert.deepEqual(twice, once);
    });

    it("leaves non-server entries untouched", () => {
        const config = { nodeName: "pve", vmid: 100 };
        assert.deepEqual(normalizeServerConfig({ ...config }, { type: "pve-qemu" }), config);
    });
});

describe("resolveSessionProtocol", () => {
    const entry = serverEntry({ protocol: "ssh", protocols: { ssh: { enabled: true, port: 22 }, rdp: { enabled: true, port: 3389 }, vnc: { enabled: false } } });

    it("defaults to the primary protocol", () => {
        assert.deepEqual(resolveSessionProtocol(entry, null), { protocol: "ssh" });
    });

    it("accepts any enabled protocol", () => {
        assert.deepEqual(resolveSessionProtocol(entry, "rdp"), { protocol: "rdp" });
    });

    it("rejects a disabled protocol", () => {
        assert.match(resolveSessionProtocol(entry, "vnc").error, /not enabled/i);
    });

    it("rejects an unknown protocol", () => {
        assert.match(resolveSessionProtocol(entry, "gopher").error, /unknown/i);
    });

    it("allows the remote browser only when SSH is enabled", () => {
        assert.deepEqual(resolveSessionProtocol(entry, "web"), { protocol: "web" });
        const rdpOnly = serverEntry({ protocol: "rdp", protocols: { rdp: { enabled: true } } });
        assert.match(resolveSessionProtocol(rdpOnly, "web").error, /ssh/i);
    });

    it("uses the entry type for Proxmox entries", () => {
        assert.deepEqual(resolveSessionProtocol({ type: "pve-qemu", config: {} }, null), { protocol: "pve-qemu" });
        assert.match(resolveSessionProtocol({ type: "pve-lxc", config: {} }, "rdp").error, /not available/i);
    });
});

describe("renderers and primary protocol", () => {
    it("maps protocols to their renderer", () => {
        assert.equal(getRendererForProtocol("ssh"), "terminal");
        assert.equal(getRendererForProtocol("rdp"), "guac");
        assert.equal(getRendererForProtocol("ftps"), "sftp");
        assert.equal(getRendererForProtocol("web"), "web");
    });

    it("returns the entry type for non-server entries", () => {
        assert.equal(getPrimaryProtocol({ type: "pve-shell", config: {} }), "pve-shell");
    });

    it("keeps every known protocol mapped", () => {
        for (const protocol of PROTOCOLS) assert.ok(getRendererForProtocol(protocol));
    });

    it("accepts a bare config as well as an entry", () => {
        const config = { protocol: "ssh", port: 22 };
        assert.equal(getProtocolMap(config).ssh.enabled, true);
        assert.deepEqual(getEnabledProtocols(config), ["ssh", "sftp"]);
    });
});
