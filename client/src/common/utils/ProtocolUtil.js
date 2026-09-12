/**
 * Client-side mirror of server/utils/entryProtocols.js.
 *
 * A server entry can enable several protocols at once (`config.protocols`), with `config.protocol`
 * naming the primary one used by the default "Connect" action. The list API flattens the enabled
 * protocols into `entry.protocols` (array, primary first).
 */

export const PROTOCOLS = ["ssh", "telnet", "rdp", "vnc", "sftp", "ftp", "ftps", "demo"];

export const DEFAULT_PORTS = { ssh: 22, telnet: 23, rdp: 3389, vnc: 5900, sftp: 22, ftp: 21, ftps: 21, demo: 0 };

export const PROTOCOL_LABELS = { ssh: "SSH", telnet: "Telnet", rdp: "RDP", vnc: "VNC", sftp: "SFTP", ftp: "FTP", ftps: "FTPS", demo: "Demo" };

export const PROTOCOL_RENDERERS = {
    ssh: "terminal",
    telnet: "terminal",
    rdp: "guac",
    vnc: "guac",
    demo: "guac",
    sftp: "sftp",
    ftp: "sftp",
    ftps: "sftp",
    web: "web",
};

export const TERMINAL_PROTOCOLS = ["ssh", "telnet"];
export const GUAC_PROTOCOLS = ["rdp", "vnc", "demo"];
export const FILE_PROTOCOLS = ["sftp", "ftp", "ftps"];
export const CREDENTIALLESS_PROTOCOLS = ["telnet", "demo"];

/** Protocols the user can pick in the server dialog (demo is dev-only and seeded separately). */
export const SELECTABLE_PROTOCOLS = ["ssh", "sftp", "telnet", "rdp", "vnc", "ftp", "ftps"];

export const isCredentiallessProtocol = (protocol) => CREDENTIALLESS_PROTOCOLS.includes(protocol);

/**
 * Enabled protocols from a raw entry config (as edited in the dialog), primary first.
 * Falls back to the single legacy `protocol` when no map exists; SSH implies SFTP unless disabled.
 */
export const getEnabledProtocolsFromConfig = (config) => {
    if (!config) return [];
    const map = config.protocols && typeof config.protocols === "object" ? config.protocols : null;
    const enabled = new Set();

    if (map) {
        for (const protocol of PROTOCOLS) {
            if (map[protocol]?.enabled) enabled.add(protocol);
        }
        if (enabled.has("ssh") && map.sftp === undefined) enabled.add("sftp");
    } else if (config.protocol) {
        enabled.add(config.protocol);
        if (config.protocol === "ssh") enabled.add("sftp");
    }

    const list = PROTOCOLS.filter(p => enabled.has(p));
    if (config.protocol && list.includes(config.protocol)) {
        return [config.protocol, ...list.filter(p => p !== config.protocol)];
    }
    return list;
};

/** Enabled protocols of a server object as returned by the entries list / detail API. */
export const getServerProtocols = (server) => {
    if (!server) return [];
    if (server.type && server.type !== "server") return [server.type];
    if (Array.isArray(server.protocols) && server.protocols.length > 0) return server.protocols;
    if (server.config) return getEnabledProtocolsFromConfig(server.config);
    if (server.protocol) return server.protocol === "ssh" ? ["ssh", "sftp"] : [server.protocol];
    return [];
};

export const hasProtocol = (server, protocol) => getServerProtocols(server).includes(protocol);

export const getPrimaryProtocol = (server) => {
    if (!server) return null;
    if (server.type && server.type !== "server") return server.type;
    return server.protocol || getServerProtocols(server)[0] || null;
};

/** Port for a protocol from a dialog config (per-protocol port, legacy port, or default). */
export const getProtocolPortFromConfig = (config, protocol) => {
    const entry = config?.protocols?.[protocol];
    if (entry?.port !== undefined && entry?.port !== null && entry?.port !== "") return entry.port;
    if (protocol === "sftp" && config?.protocols?.ssh?.port) return config.protocols.ssh.port;
    if (protocol === config?.protocol && config?.port) return config.port;
    return DEFAULT_PORTS[protocol] ?? "";
};

/** Renderer used by a session opened over `protocol` (or the special "web" type). */
export const getRendererForProtocol = (protocol) => PROTOCOL_RENDERERS[protocol] || null;

/**
 * The `type` value POST /connections expects for a protocol, and the `type` stored on the client
 * session (which the tab/view layer uses as a renderer override).
 */
export const getSessionTypeForProtocol = (protocol) => {
    if (!protocol || protocol === "web") return protocol || null;
    if (FILE_PROTOCOLS.includes(protocol)) return "sftp";
    return null;
};

/** Builds the `protocols` map for a freshly created entry of the given protocol. */
export const seedProtocolMap = (protocol, port = null) => {
    const resolvedPort = port ?? DEFAULT_PORTS[protocol] ?? "";
    const map = { [protocol]: { enabled: true, port: resolvedPort } };
    if (protocol === "ssh") map.sftp = { enabled: true, port: resolvedPort };
    return map;
};
