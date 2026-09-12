/**
 * Multi-protocol connection model.
 *
 * A "server" entry can expose several protocols on the same host (e.g. SSH + SFTP + RDP).
 * The per-protocol state lives in `entry.config.protocols`:
 *
 *   protocols: {
 *     ssh:  { enabled: true,  port: 22 },
 *     sftp: { enabled: true,  port: 22 },
 *     rdp:  { enabled: true,  port: 3389 },
 *     vnc:  { enabled: false, port: 5900 },
 *   }
 *
 * For backwards compatibility `config.protocol` (the *primary* protocol, used by the default
 * "Connect" action, the mobile app, the CLI and the `renderer` column) and `config.port`
 * (the primary protocol's port) are kept in sync with the map. Entries that predate the map
 * are treated as having exactly their primary protocol enabled (plus SFTP when SSH is enabled,
 * which mirrors the behaviour Nexterm always had).
 */

const PROTOCOLS = ["ssh", "telnet", "rdp", "vnc", "sftp", "ftp", "ftps", "demo"];

const DEFAULT_PORTS = { ssh: 22, telnet: 23, rdp: 3389, vnc: 5900, sftp: 22, ftp: 21, ftps: 21, demo: 0 };

const PROTOCOL_RENDERERS = {
    ssh: "terminal",
    telnet: "terminal",
    rdp: "guac",
    vnc: "guac",
    demo: "guac",
    sftp: "sftp",
    ftp: "sftp",
    ftps: "sftp",
};

/** Session "types" that are not protocols of their own but ride on top of SSH. */
const SSH_DERIVED_TYPES = { web: "web" };

const TERMINAL_PROTOCOLS = new Set(["ssh", "telnet"]);
const GUAC_PROTOCOLS = new Set(["rdp", "vnc", "demo"]);
const FILE_PROTOCOLS = new Set(["sftp", "ftp", "ftps"]);
const CREDENTIALLESS_PROTOCOLS = new Set(["telnet", "demo"]);

const isServerEntry = (entry) => !entry?.type || entry.type === "server";

/** Accepts either an Entry (model instance or plain object with `.config`) or a bare config object. */
const getConfig = (entryOrConfig) => {
    if (!entryOrConfig) return {};
    if (entryOrConfig.config !== undefined && (entryOrConfig.type !== undefined || entryOrConfig.id !== undefined)) {
        return entryOrConfig.config || {};
    }
    return entryOrConfig;
};

const parsePort = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    const port = Number.parseInt(value, 10);
    return Number.isFinite(port) && port >= 0 && port <= 65535 ? port : fallback;
};

/**
 * Builds the effective protocol map for a config, applying legacy fallbacks.
 * Returns `{ [protocol]: { enabled, port } }` containing only known protocols.
 */
const getProtocolMap = (entryOrConfig) => {
    const config = getConfig(entryOrConfig);
    const raw = config.protocols && typeof config.protocols === "object" && !Array.isArray(config.protocols) ? config.protocols : null;
    const map = {};

    if (raw) {
        for (const protocol of PROTOCOLS) {
            const value = raw[protocol];
            if (value === undefined || value === null) continue;
            const enabled = typeof value === "object" ? Boolean(value.enabled) : Boolean(value);
            const port = parsePort(typeof value === "object" ? value.port : undefined, DEFAULT_PORTS[protocol]);
            map[protocol] = { enabled, port };
        }
    }

    // Legacy single-protocol entry (or map missing the primary): the primary protocol is enabled.
    const primary = config.protocol;
    if (primary && PROTOCOLS.includes(primary) && !map[primary]) {
        map[primary] = { enabled: !raw, port: parsePort(config.port, DEFAULT_PORTS[primary]) };
    }

    // SFTP has always been implicitly available on SSH entries; keep that unless explicitly disabled.
    if (map.ssh?.enabled && map.sftp === undefined) {
        map.sftp = { enabled: true, port: map.ssh.port };
    }

    return map;
};

const getEnabledProtocols = (entryOrConfig) => {
    const config = getConfig(entryOrConfig);
    const map = getProtocolMap(config);
    const enabled = PROTOCOLS.filter(p => map[p]?.enabled);
    const primary = config.protocol;
    if (primary && enabled.includes(primary)) {
        return [primary, ...enabled.filter(p => p !== primary)];
    }
    return enabled;
};

const isProtocolEnabled = (entryOrConfig, protocol) => Boolean(getProtocolMap(entryOrConfig)[protocol]?.enabled);

/** Primary protocol of an entry (for non-server entries this is the entry type, e.g. "pve-qemu"). */
const getPrimaryProtocol = (entry) => {
    if (!entry) return null;
    if (!isServerEntry(entry)) return entry.type;
    const config = entry.config || {};
    if (config.protocol && isProtocolEnabled(config, config.protocol)) return config.protocol;
    return getEnabledProtocols(config)[0] || config.protocol || null;
};

/** Port to use for a given protocol on an entry. */
const getProtocolPort = (entry, protocol) => {
    const config = getConfig(entry);
    const map = getProtocolMap(config);
    if (map[protocol]?.port !== undefined) return map[protocol].port;
    if (protocol === "sftp" && map.ssh) return map.ssh.port;
    if (protocol === config.protocol) return parsePort(config.port, DEFAULT_PORTS[protocol] ?? 22);
    return DEFAULT_PORTS[protocol] ?? 22;
};

/**
 * Resolves which protocol a new session should use.
 * `requested` is the `type` parameter of POST /connections: a protocol name, "web", or null
 * (= the entry's primary protocol). Returns `{ protocol, error }`.
 */
const resolveSessionProtocol = (entry, requested = null) => {
    if (!isServerEntry(entry)) {
        if (requested && requested !== entry.type && !SSH_DERIVED_TYPES[requested]) {
            return { error: `Protocol ${requested} is not available on this entry` };
        }
        return { protocol: entry.type };
    }

    if (!requested) {
        const primary = getPrimaryProtocol(entry);
        return primary ? { protocol: primary } : { error: "Entry has no enabled protocol" };
    }

    if (SSH_DERIVED_TYPES[requested]) {
        if (!isProtocolEnabled(entry, "ssh")) return { error: "This action requires SSH to be enabled on the entry" };
        return { protocol: requested };
    }

    if (!PROTOCOLS.includes(requested)) return { error: `Unknown protocol: ${requested}` };
    if (!isProtocolEnabled(entry, requested)) return { error: `Protocol ${requested.toUpperCase()} is not enabled on this entry` };
    return { protocol: requested };
};

const getRendererForProtocol = (protocol) => {
    if (SSH_DERIVED_TYPES[protocol]) return SSH_DERIVED_TYPES[protocol];
    return PROTOCOL_RENDERERS[protocol] || null;
};

/**
 * Normalises an incoming server config so that `protocols`, `protocol` and `port` agree.
 * Mutates and returns the config. Non-server entries are returned untouched.
 */
const normalizeServerConfig = (config, { type = "server" } = {}) => {
    if (!config || type !== "server") return config;

    const hasMap = config.protocols && typeof config.protocols === "object" && !Array.isArray(config.protocols);
    if (!hasMap && !config.protocol) return config;

    const map = getProtocolMap(config);
    const protocols = {};
    for (const protocol of PROTOCOLS) {
        if (!map[protocol]) continue;
        protocols[protocol] = { enabled: Boolean(map[protocol].enabled), port: map[protocol].port };
    }

    const enabled = PROTOCOLS.filter(p => protocols[p]?.enabled);
    let primary = config.protocol && protocols[config.protocol]?.enabled ? config.protocol : enabled[0];

    // A map that disables everything is treated as "primary only" so an entry never becomes unusable.
    if (!primary && config.protocol && PROTOCOLS.includes(config.protocol)) {
        primary = config.protocol;
        protocols[primary] = { enabled: true, port: parsePort(config.port, DEFAULT_PORTS[primary]) };
    }

    config.protocols = protocols;
    if (primary) {
        config.protocol = primary;
        config.port = protocols[primary].port;
    }
    return config;
};

module.exports = {
    PROTOCOLS,
    DEFAULT_PORTS,
    PROTOCOL_RENDERERS,
    TERMINAL_PROTOCOLS,
    GUAC_PROTOCOLS,
    FILE_PROTOCOLS,
    CREDENTIALLESS_PROTOCOLS,
    getProtocolMap,
    getEnabledProtocols,
    isProtocolEnabled,
    getPrimaryProtocol,
    getProtocolPort,
    resolveSessionProtocol,
    getRendererForProtocol,
    normalizeServerConfig,
};
