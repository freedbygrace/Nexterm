const Integration = require("../models/Integration");
const { getIdentityCredentials } = require("../controllers/identity");
const { getIntegrationCredentials } = require("../controllers/integration");
const { createTicket, getNodeForServer, openVNCConsole, openSPICEConsole } = require("../controllers/pve");

const resolveCredentials = (identity) => {
    return identity.isDirect && identity.directCredentials
        ? identity.directCredentials
        : getIdentityCredentials(identity.id);
};

const openPveBroker = async (entry) => {
    const integration = entry.integrationId ? await Integration.findByPk(entry.integrationId) : null;
    if (!integration) throw new Error("Integration not found for PVE entry");

    const integrationCreds = await getIntegrationCredentials(integration.id);
    const server = { ...integration.config, ...entry.config, password: integrationCreds.password };
    const ticket = await createTicket({ ip: server.ip, port: server.port }, server.username, server.password);
    const node = await getNodeForServer(server, ticket);

    return { server, node, ticket };
};

const buildPveQemuParams = async (entry) => {
    const { server, node, ticket } = await openPveBroker(entry);
    const vncTicket = await openVNCConsole({ ip: server.ip, port: server.port }, node, entry.config?.vmid, ticket);

    return {
        hostname: server.ip,
        port: String(vncTicket.port),
        password: vncTicket.ticket,
        "ignore-cert": "true",
    };
};

/**
 * SPICE console of a Proxmox VE QEMU VM. Proxmox brokers the console through its
 * own SPICE proxy: it hands back an opaque routing token as the hostname, the
 * proxy to connect through, a TLS port and a single-use ticket that expires in
 * about 30 seconds, so this must run immediately before the session is opened.
 *
 * The link is TLS-only, so the plaintext port is deliberately left empty: the
 * plugin then connects over tls-port rather than speaking TLS to a plain port.
 */
const buildPveQemuSpiceParams = async (entry) => {
    const { server, node, ticket } = await openPveBroker(entry);
    const spiceConsole = await openSPICEConsole({ ip: server.ip, port: server.port }, node, entry.config?.vmid, ticket);

    const cfg = entry.config || {};
    const params = {
        hostname: spiceConsole.host,
        port: "",
        password: spiceConsole.password,
        tls: "true",
        "tls-port": String(spiceConsole.tlsPort),
        proxy: spiceConsole.proxy,
        "color-depth": String(cfg.colorDepth || 24),
        "enable-audio": cfg.enableAudio !== false ? "true" : "false",
    };

    // Proxmox signs node certificates with the (self-signed) cluster CA, so the
    // only meaningful verification is against the CA and host subject it returns
    // alongside the ticket. Without them there is nothing to verify against.
    if (spiceConsole.ca && spiceConsole.hostSubject) {
        params["ca-cert"] = spiceConsole.ca;
        params["cert-subject"] = spiceConsole.hostSubject;
        params["ignore-cert"] = "false";
    } else {
        params["ignore-cert"] = "true";
    }

    return params;
};

const buildRdpParams = async (cfg, identity, accountId) => {
    const params = {
        hostname: cfg.ip,
        port: String(cfg.port || 3389),
        "ignore-cert": "true",
        "server-layout": cfg.keyboardLayout || "en-us-qwerty",
        "resize-method": (cfg.resizeMethod && cfg.resizeMethod !== "none") ? cfg.resizeMethod : "display-update",
        "secondary-monitors": 3,
    };

    if (identity) {
        let username = identity.username;
        const credentials = await resolveCredentials(identity);
        if (username?.includes("\\")) {
            const [domain, user] = username.split("\\");
            params.domain = domain;
            username = user;
        }
        params.username = username || "";
        if (credentials?.password) params.password = credentials.password;
    }

    if (cfg.rdpSecurity) params["security"] = cfg.rdpSecurity;

    if (cfg.colorDepth) params["color-depth"] = String(cfg.colorDepth);
    if (cfg.enableWallpaper !== false) params["enable-wallpaper"] = "true";
    if (cfg.enableTheming !== false) params["enable-theming"] = "true";
    if (cfg.enableFontSmoothing !== false) params["enable-font-smoothing"] = "true";
    if (cfg.enableFullWindowDrag === true) params["enable-full-window-drag"] = "true";
    if (cfg.enableDesktopComposition === true) params["enable-desktop-composition"] = "true";
    if (cfg.enableMenuAnimations === true) params["enable-menu-animations"] = "true";

    if (accountId !== undefined && accountId !== null) {
        params["enable-drive"] = "true";
        params["drive-name"] = "Shared";
        params["drive-backend"] = "client";
    }

    return params;
};

const buildVncParams = async (cfg, identity) => {
    const params = {
        hostname: cfg.ip,
        port: String(cfg.port || 5900),
        "ignore-cert": "true",
    };

    if (identity) {
        const credentials = await resolveCredentials(identity);
        if (identity.username) params.username = identity.username;
        if (credentials?.password) params.password = credentials.password;
    }

    if (cfg.colorDepth) params["color-depth"] = String(cfg.colorDepth);
    if (cfg.resizeMethod && cfg.resizeMethod !== "none") params["resize-method"] = cfg.resizeMethod;

    return params;
};

const buildSpiceParams = async (cfg, identity) => {
    const params = {
        hostname: cfg.ip,
        port: String(cfg.port || 5900),
        "color-depth": String(cfg.colorDepth || 24),
        "enable-audio": cfg.enableAudio !== false ? "true" : "false",
    };

    if (identity) {
        const credentials = await resolveCredentials(identity);
        if (identity.username) params.username = identity.username;
        if (credentials?.password) params.password = credentials.password;
    }

    if (cfg.keyboardLayout) params["server-layout"] = cfg.keyboardLayout;

    return params;
};

const buildWebParams = (vncPort) => ({
    hostname: "127.0.0.1",
    port: String(vncPort),
    "color-depth": "24",
});

const buildDemoParams = async () => ({});

module.exports = {
    buildPveQemuParams,
    buildPveQemuSpiceParams,
    buildRdpParams,
    buildVncParams,
    buildSpiceParams,
    buildWebParams,
    buildDemoParams,
};
