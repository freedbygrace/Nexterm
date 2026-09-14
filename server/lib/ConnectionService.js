const SessionManager = require("./SessionManager");
const GuacdClient = require("./GuacdClient");
const logger = require("../utils/logger");
const { getIdentityCredentials } = require("../controllers/identity");
const { getIntegrationCredentials } = require("../controllers/integration");
const { createTicket, getNodeForServer, openLXCConsole } = require("../controllers/pve");
const Entry = require("../models/Entry");
const Integration = require("../models/Integration");
const { resolveIdentity } = require("../utils/identityResolver");
const { getScript } = require("../controllers/script");
const OrganizationMember = require("../models/OrganizationMember");
const { ScriptLayer } = require("./ScriptLayer");
const { SessionType } = require("./generated/control_plane_generated");
const controlPlane = require("./controlPlane/ControlPlaneServer");
const { isRecordingEnabled } = require("../utils/recordingService");
const EngineSftpClient = require("./EngineSftpClient");
const {
    buildPveQemuParams,
    buildPveQemuSpiceParams,
    buildRdpParams,
    buildVncParams,
    buildSpiceParams,
    buildWebParams,
    buildDemoParams,
} = require("./guacParamBuilders");
const { getPrimaryProtocol, getProtocolPort, DEFAULT_PORTS, FILE_PROTOCOLS } = require("../utils/entryProtocols");

const GUAC_PROTOCOLS = {
    rdp: { sessionType: SessionType.RDP, defaultPort: 3389 },
    vnc: { sessionType: SessionType.VNC, defaultPort: 5900 },
    spice: { sessionType: SessionType.SPICE, defaultPort: 5900 },
    "pve-qemu": { sessionType: SessionType.VNC, defaultPort: 5900 },
    demo: { sessionType: SessionType.Demo, defaultPort: 0 },
};

const requireEngine = () => {
    if (!controlPlane.hasEngine()) throw new Error("No engine connected");
};

const requireSession = (sessionId) => {
    const session = SessionManager.get(sessionId);
    if (!session) throw new Error("Session not found");
    return session;
};

const resolveCredentials = async (identity) => {
    return identity.isDirect && identity.directCredentials
        ? identity.directCredentials
        : await getIdentityCredentials(identity.id);
};

const buildSSHParams = (identity, credentials) => {
    const params = { username: identity.username || credentials.username || "" };
    if (credentials.password) params.password = credentials.password;
    if (credentials.privateKey || credentials["ssh-key"]) params.privateKey = credentials.privateKey || credentials["ssh-key"];
    if (credentials.passphrase) params.passphrase = credentials.passphrase;
    if (credentials.sshCertificate || credentials["ssh-cert"]) params.certificate = credentials.sshCertificate || credentials["ssh-cert"];
    return params;
};

// Telnet has no authentication handshake. Credentials are sent only after the
// explicitly configured prompts appear in the terminal stream. Entries without
// prompts (or without an identity) remain manual Telnet sessions.
const buildTelnetParams = (identity, credentials, serverConfig = null) => {
    if (!identity) return {};

    const params = { username: identity.username || credentials.username || "" };
    if (credentials.password) params.password = credentials.password;
    const usernamePrompt = serverConfig?.telnetUsernamePrompt?.trim();
    const passwordPrompt = serverConfig?.telnetPasswordPrompt?.trim();
    if (usernamePrompt) params.usernamePrompt = usernamePrompt;
    if (passwordPrompt) params.passwordPrompt = passwordPrompt;
    return params;
};

const createTelnetPromptLoginHandler = (dataSocket, params, context) => {
    if (!params.username || !params.password || !params.usernamePrompt || !params.passwordPrompt) return null;

    let buffer = "";
    let state = "username";
    const { sessionId, ip, port } = context;

    return (data) => {
        if (state === "complete") return;
        buffer = `${buffer}${data.toString()}`.slice(-8192);

        if (state === "username" && buffer.includes(params.usernamePrompt)) {
            dataSocket.write(`${params.username}\r\n`);
            state = "password";
            logger.info("Telnet username prompt matched", { sessionId, target: ip, port });
            return;
        }

        if (state === "password" && buffer.includes(params.passwordPrompt)) {
            dataSocket.write(`${params.password}\r\n`);
            state = "complete";
            logger.info("Telnet password prompt matched", { sessionId, target: ip, port });
        }
    };
};

const extractIdentity = (identityResult) => {
    return identityResult?.identity === undefined ? identityResult : identityResult.identity;
};

const getEntryProtocol = (entry) => getPrimaryProtocol(entry);

/** Protocol a session runs over: the resolved per-session protocol, falling back to the entry's primary. */
const getSessionProtocol = (session, entry) => session?.configuration?.protocol || getPrimaryProtocol(entry);

/**
 * Host and port for `protocol` on the entry. Each enabled protocol carries its own port
 * (see utils/entryProtocols); `defaultPort` is only used when the entry has no port at all.
 */
const getHostPort = (entry, protocol = "ssh", defaultPort = null) => {
    const host = entry.config?.ip;
    if (!host) throw new Error("Missing host configuration");
    const port = entry.type === "server" || !entry.type
        ? getProtocolPort(entry, protocol)
        : (entry.config?.port || defaultPort || DEFAULT_PORTS[protocol] || 22);
    return { host, port };
};

const resolveJumpHosts = async (entry) => {
    const jumpHostIds = entry.config?.jumpHosts;
    if (!jumpHostIds || jumpHostIds.length === 0) return [];

    const jumpHosts = [];
    for (const jumpHostId of jumpHostIds) {
        const jhEntry = await Entry.findByPk(jumpHostId);
        if (!jhEntry) throw new Error(`Jump host entry ${jumpHostId} not found`);

        const { host, port } = getHostPort(jhEntry);
        const identityResult = await resolveIdentity(jhEntry, null, null, null, "ssh");
        const identity = extractIdentity(identityResult);
        if (!identity) throw new Error(`No identity found for jump host ${jumpHostId}`);

        const credentials = await resolveCredentials(identity);
        jumpHosts.push({
            host,
            port,
            username: identity.username || credentials.username || "",
            password: credentials.password || null,
            privateKey: credentials.privateKey || credentials["ssh-key"] || null,
            passphrase: credentials.passphrase || null,
            certificate: credentials.sshCertificate || credentials["ssh-cert"] || null,
        });
    }
    return jumpHosts;
};

const openEngineSessionWithResult = async (sessionId, sessionType, host, port, params, jumpHosts = [], engineId) => {
    const dataSocketPromise = controlPlane.waitForDataConnection(sessionId);
    dataSocketPromise.catch(() => {});

    const result = await controlPlane.openSession(sessionId, sessionType, host, port, params, jumpHosts, engineId || null);
    return { dataSocket: await dataSocketPromise, result };
};

const openEngineSession = async (...args) => (await openEngineSessionWithResult(...args)).dataSocket;

const createConnectionForSession = async (sessionId, accountId) => {
    const session = requireSession(sessionId);

    const entry = await Entry.findByPk(session.entryId);
    if (!entry) throw new Error("Entry not found");

    const { type, identityId, directIdentity, scriptId } = session.configuration;
    const protocol = getSessionProtocol(session, entry);
    if (type === "sftp" || FILE_PROTOCOLS.has(protocol)) return { success: true, skipped: true };

    const identityResult = await resolveIdentity(entry, identityId, directIdentity, accountId, protocol);
    const identity = extractIdentity(identityResult);
    const organizationId = entry.organizationId || null;

    let script = null;
    if (scriptId) {
        const memberships = await OrganizationMember.findAll({ where: { accountId } });
        script = await getScript(accountId, scriptId, null, memberships.map(m => m.organizationId));
        if (!script) throw new Error("Script not found");
    }

    if (type === "web" || protocol === "web") return prepareWebSession(sessionId, entry, identity, organizationId);

    switch (protocol) {
        case "ssh": return createSSHConnectionForSession(sessionId, entry, identity, organizationId, script);
        case "telnet": return createTelnetConnectionForSession(sessionId, entry, identity, organizationId);
        case "pve-lxc":
        case "pve-shell": return createPveLxcConnectionForSession(sessionId, entry, organizationId);
        case "pve-qemu":
        case "rdp":
        case "vnc":
        case "spice":
        case "demo": return prepareGuacamoleSession(sessionId, entry, identity, organizationId);
        case "sftp":
        case "ftp":
        case "ftps": return { success: true, skipped: true };
        default: throw new Error(`Unsupported protocol: ${protocol}`);
    }
};

const resolveFileTransferContext = async (entry, identityId, directIdentity, accountId, sessionProtocol = null) => {
    // A file session on a multi-protocol entry may use SFTP even when the primary protocol is SSH/RDP.
    let protocol = sessionProtocol && FILE_PROTOCOLS.has(sessionProtocol) ? sessionProtocol : getEntryProtocol(entry);
    if (!FILE_PROTOCOLS.has(protocol)) protocol = "sftp";
    const identityResult = await resolveIdentity(entry, identityId, directIdentity, accountId, protocol);
    const identity = extractIdentity(identityResult);
    const credentials = await resolveCredentials(identity);
    const { host, port } = getHostPort(entry, protocol);
    const params = buildSSHParams(identity, credentials);
    params.protocol = protocol;
    return { identity, credentials, host, port, params };
};

const createSFTPConnectionForSession = async (sessionId, entry, accountId) => {
    const session = requireSession(sessionId);
    if (session.masterConnection?.sftpClient) return { success: true };
    if (session._connecting) return session._connecting;

    session._connecting = (async () => {
        requireEngine();
        const { identityId, directIdentity, protocol: sessionProtocol } = session.configuration;
        const { host, port, params } = await resolveFileTransferContext(entry, identityId, directIdentity, accountId, sessionProtocol);
        const jumpHosts = await resolveJumpHosts(entry);

        const dataSocket = await openEngineSession(
            sessionId, SessionType.SFTP, host, port, params, jumpHosts, entry.config?.engineId
        );

        const sftpClient = new EngineSftpClient(dataSocket);
        await sftpClient.waitForReady();

        dataSocket.on("close", () => {
            logger.info("SFTP data connection closed", { sessionId });
            SessionManager.remove(sessionId);
        });
        dataSocket.on("error", (err) => {
            logger.error("SFTP data socket error", { sessionId, error: err.message });
            SessionManager.markFailed(sessionId, err.message);
            SessionManager.remove(sessionId, { code: 4017, reason: err.message });
        });

        SessionManager.setConnection(sessionId, {
            sftpClient,
            dataSocket,
            type: "sftp",
            auditLogId: session.auditLogId,
        });

        logger.info("SFTP connected", { sessionId, target: host, port });
        return { success: true };
    })().finally(() => { session._connecting = null; });

    return session._connecting;
};

const getAuxiliarySFTPClient = async (sessionId, entry, accountId, opts) => {
    const { suffix, clientKey, connectingKey, label } = opts;
    const session = requireSession(sessionId);
    const conn = SessionManager.getConnection(sessionId);
    if (!conn) throw new Error("No active SFTP session");
    if (conn[clientKey] && !conn[clientKey]._closed) return conn[clientKey];
    if (conn[connectingKey]) return conn[connectingKey];

    conn[connectingKey] = (async () => {
        requireEngine();
        const { identityId, directIdentity, protocol: sessionProtocol } = session.configuration;
        const { host, port, params } = await resolveFileTransferContext(entry, identityId, directIdentity, accountId, sessionProtocol);
        const jumpHosts = await resolveJumpHosts(entry);

        conn._auxGeneration = (conn._auxGeneration || 0) + 1;
        const engineSessionId = `${sessionId}-${suffix}-${conn._auxGeneration}`;
        if (!conn.auxSessionIds) conn.auxSessionIds = new Set();
        conn.auxSessionIds.add(engineSessionId);

        const dataSocket = await openEngineSession(
            engineSessionId, SessionType.SFTP, host, port, params, jumpHosts, entry.config?.engineId
        );

        const client = new EngineSftpClient(dataSocket);
        await client.waitForReady();

        const detach = () => { if (conn[clientKey] === client) conn[clientKey] = null; };
        dataSocket.on("close", detach);
        dataSocket.on("error", detach);

        conn[clientKey] = client;
        logger.info(`SFTP ${label} connection established`, { sessionId, target: host, port });
        return client;
    })().finally(() => { conn[connectingKey] = null; });

    return conn[connectingKey];
};

const getSFTPTransferClient = (sessionId, entry, accountId) =>
    getAuxiliarySFTPClient(sessionId, entry, accountId, {
        suffix: "xfer", clientKey: "transferClient", connectingKey: "_transferConnecting", label: "transfer",
    });

const getSFTPBackgroundClient = (sessionId, entry, accountId) =>
    getAuxiliarySFTPClient(sessionId, entry, accountId, {
        suffix: "bg", clientKey: "backgroundClient", connectingKey: "_backgroundConnecting", label: "background",
    });

const getSFTPAIClient = (sessionId, entry, accountId) =>
    getAuxiliarySFTPClient(sessionId, entry, accountId, {
        suffix: "ai", clientKey: "aiClient", connectingKey: "_aiConnecting", label: "ai",
    });

const getSessionPassword = async (sessionId, entry, accountId) => {
    const session = requireSession(sessionId);
    const { identityId, directIdentity } = session.configuration;
    const { params } = await resolveFileTransferContext(entry, identityId, directIdentity, accountId);
    return params.password || null;
};

const createSSHConnectionForSession = async (sessionId, entry, identity, organizationId, script = null) => {
    const session = requireSession(sessionId);
    if (session._connecting) return session._connecting;

    session._connecting = (async () => {
        requireEngine();
        const credentials = await resolveCredentials(identity);
        const { host, port } = getHostPort(entry);
        const params = buildSSHParams(identity, credentials);
        const jumpHosts = await resolveJumpHosts(entry);

        const dataSocket = await openEngineSession(
            sessionId, SessionType.SSH, host, port, params, jumpHosts, entry.config?.engineId
        );

        await SessionManager.initRecording(sessionId, organizationId);

        dataSocket.on("data", (data) => SessionManager.appendLog(sessionId, data.toString()));
        dataSocket.on("close", () => {
            logger.info("SSH data connection closed", { sessionId });
            SessionManager.remove(sessionId);
        });
        dataSocket.on("error", (err) => {
            logger.error("SSH data socket error", { sessionId, error: err.message });
            SessionManager.markFailed(sessionId, err.message);
            SessionManager.remove(sessionId, { code: 4017, reason: "Connection lost" });
        });

        let scriptLayer = null;
        if (script) {
            scriptLayer = new ScriptLayer(dataSocket, null, script, sessionId);
            scriptLayer.start();
        }

        SessionManager.setConnection(sessionId, {
            dataSocket,
            sessionId,
            type: "ssh",
            auditLogId: session.auditLogId,
            scriptLayer,
        });

        if (!script && session.configuration.startPath) {
            const raw = String(session.configuration.startPath);
            if (/[\r\n\x00]/.test(raw)) {
                logger.warn("Ignoring startPath containing control characters", { sessionId });
            } else {
                const quoted = `'${raw.replace(/'/g, `'\\''`)}'`;
                dataSocket.write(`cd ${quoted}\n`);
            }
        }

        logger.info("SSH connected", { sessionId, target: host, port });
        return { success: true };
    })().finally(() => { session._connecting = null; });

    return session._connecting;
};

const createTelnetConnectionForSession = async (sessionId, entry, identity, organizationId) => {
    requireEngine();
    const session = requireSession(sessionId);
    const { host: ip, port } = getHostPort(entry, "telnet");

    const credentials = identity ? await resolveCredentials(identity) : {};
    const params = buildTelnetParams(identity, credentials, entry.config);
    const dataSocket = await openEngineSession(
        sessionId, SessionType.Telnet, ip, port, params, [], entry.config?.engineId
    );

    await SessionManager.initRecording(sessionId, organizationId);

    const promptLoginHandler = createTelnetPromptLoginHandler(dataSocket, params, { sessionId, ip, port });
    dataSocket.on("data", (data) => {
        SessionManager.appendLog(sessionId, data.toString());
        promptLoginHandler?.(data);
    });
    dataSocket.on("close", () => {
        logger.info("Telnet data connection closed", { sessionId });
        SessionManager.remove(sessionId);
    });
    dataSocket.on("error", (err) => {
        logger.error("Telnet data socket error", { sessionId, error: err.message });
        SessionManager.markFailed(sessionId, err.message);
        SessionManager.remove(sessionId, { code: 4017, reason: err.message });
    });

    SessionManager.setConnection(sessionId, {
        dataSocket,
        sessionId,
        type: "telnet",
        auditLogId: session.auditLogId,
    });

    logger.info("Telnet connected", {
        sessionId,
        ip,
        port,
        autoLogin: Boolean(promptLoginHandler),
    });
    return { success: true };
}

const createPveLxcConnectionForSession = async (sessionId, entry, organizationId) => {
    requireEngine();
    const session = requireSession(sessionId);

    const integration = entry.integrationId ? await Integration.findByPk(entry.integrationId) : null;
    if (!integration) throw new Error("Integration not found for PVE entry");

    const vmid = entry.config?.vmid ?? "0";
    const integrationCreds = await getIntegrationCredentials(integration.id);
    const server = { ...integration.config, ...entry.config, password: integrationCreds.password };
    const ticket = await createTicket({ ip: server.ip, port: server.port }, server.username, server.password);
    const node = await getNodeForServer(server, ticket);
    const vncTicket = await openLXCConsole({ ip: server.ip, port: server.port }, node, vmid, ticket);

    const containerPart = vmid === 0 || vmid === "0" ? "" : `lxc/${vmid}`;
    const wsUrl = `wss://${server.ip}:${server.port}/api2/json/nodes/${node}/${containerPart}/vncwebsocket?port=${vncTicket.port}&vncticket=${encodeURIComponent(vncTicket.ticket)}`;

    const params = {
        ws_url: wsUrl,
        ws_insecure: "true",
        ws_header_Cookie: `PVEAuthCookie=${ticket.ticket}`,
    };

    const dataSocket = await openEngineSession(
        sessionId, SessionType.WebSocket, server.ip, Number(server.port) || 8006, params, [], entry.config?.engineId
    );

    dataSocket.write(`${server.username}:${vncTicket.ticket}\n`);

    await SessionManager.initRecording(sessionId, organizationId);

    const keepAliveTimer = setInterval(() => {
        if (!dataSocket.destroyed) dataSocket.write("2");
    }, 30000);

    dataSocket.on("data", (data) => {
        const text = data.toString();
        if (text !== "OK") SessionManager.appendLog(sessionId, text);
    });

    dataSocket.on("close", () => {
        clearInterval(keepAliveTimer);
        SessionManager.remove(sessionId);
    });

    dataSocket.on("error", (err) => {
        clearInterval(keepAliveTimer);
        logger.error("PVE LXC data socket error", { sessionId, error: err.message });
        SessionManager.markFailed(sessionId, err.message);
        SessionManager.remove(sessionId, { code: 4017, reason: err.message });
    });

    SessionManager.setConnection(sessionId, {
        dataSocket,
        keepAliveTimer,
        type: "pve-lxc",
        auditLogId: session.auditLogId,
    });

    logger.info("PVE LXC connected via engine", { sessionId, vmid });
    return { success: true };
}

const prepareWebSession = async (sessionId, entry, identity, organizationId) => {
    const session = requireSession(sessionId);
    requireEngine();

    const credentials = await resolveCredentials(identity);
    const { host, port } = getHostPort(entry);
    const params = buildSSHParams(identity, credentials);
    const jumpHosts = await resolveJumpHosts(entry);

    const { dataSocket, result } = await openEngineSessionWithResult(
        sessionId, SessionType.Web, host, port, params, jumpHosts, entry.config?.engineId
    );

    let vncPort = null;
    try {
        vncPort = JSON.parse(result?.metadata || "{}").vncPort;
    } catch {
        vncPort = null;
    }

    if (!vncPort) {
        dataSocket.destroy();
        throw new Error("Engine did not report a browser display port");
    }

    const recordingEnabled = await isRecordingEnabled(organizationId);
    if (recordingEnabled && session.auditLogId) {
        controlPlane.registerRecordingSession(sessionId, session.auditLogId);
    }

    const masterClient = new GuacdClient({
        sessionId,
        connectionSettings: {
            connection: { type: "vnc", width: 1280, height: 720, dpi: 96, ...buildWebParams(vncPort) },
            enableAudio: false,
        },
        recordingEnabled,
        auditLogId: session.auditLogId,
        existingSocket: dataSocket,
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Master handshake timeout")), 15000);
        masterClient.onReadyCallback = (connectionId) => { clearTimeout(timeout); resolve(connectionId); };
        masterClient.onCloseCallback = (reason) => { clearTimeout(timeout); reject(new Error("Master connection failed: " + reason)); };
        masterClient.connect();
    });

    SessionManager.setGuacReady(sessionId);

    SessionManager.setConnection(sessionId, {
        guacdClient: masterClient,
        dataSocket,
        type: "guac",
        auditLogId: session.auditLogId,
    });

    logger.info("Web session prepared", { sessionId, sshHost: host, sshPort: port, vncPort });
    return { success: true };
}

const prepareGuacamoleSession = async (sessionId, entry, identity, organizationId) => {
    const session = requireSession(sessionId);
    requireEngine();
    const protocol = getSessionProtocol(session, entry);
    const cfg = entry.config || {};

    // A pve-qemu entry opens either the VNC or the SPICE console of the VM.
    const pveSpice = entry.type === "pve-qemu" && cfg.consoleType === "spice";

    let params;
    if (pveSpice) {
        params = await buildPveQemuSpiceParams(entry);
    } else if (entry.type === "pve-qemu") {
        params = await buildPveQemuParams(entry);
    } else if (protocol === "rdp") {
        params = await buildRdpParams(cfg, identity, session.accountId);
    } else if (protocol === "vnc") {
        params = await buildVncParams(cfg, identity);
    } else if (protocol === "spice") {
        params = await buildSpiceParams(cfg, identity);
    } else if (protocol === "demo") {
        params = await buildDemoParams();
    } else {
        throw new Error(`Unsupported protocol: ${protocol}`);
    }

    // Multi-protocol entries carry one port per protocol; the builders only know the legacy `config.port`.
    if (entry.type === "server" && (protocol === "rdp" || protocol === "vnc" || protocol === "spice")) {
        params.port = String(getProtocolPort(entry, protocol));
    }

    const { sessionType, defaultPort } = pveSpice
        ? GUAC_PROTOCOLS.spice
        : GUAC_PROTOCOLS[protocol] ?? GUAC_PROTOCOLS.vnc;
    const host = params.hostname || cfg.ip || "";
    // A TLS-only SPICE console has no plaintext port; its tls-port is the real target.
    const port = Number.parseInt(params.port || params["tls-port"] || cfg.port || defaultPort, 10);

    // The Proxmox SPICE host is an opaque proxy routing token rather than a
    // reachable address, so it cannot be tunnelled; the engine reaches the VM
    // through the SPICE proxy itself.
    const jumpHosts = pveSpice ? [] : await resolveJumpHosts(entry);
    if (pveSpice && (entry.config?.jumpHosts?.length || 0) > 0) {
        logger.warn("Jump hosts are ignored for Proxmox SPICE consoles", { sessionId });
    }

    const { dataSocket, result } = await openEngineSessionWithResult(
        sessionId, sessionType, host, port, params, jumpHosts, entry.config?.engineId
    );

    if (jumpHosts.length > 0) {
        if (!result?.localPort) {
            dataSocket.destroy();
            controlPlane.closeSession(sessionId);
            throw new Error("Engine did not provide a jump host tunnel; please update the engine");
        }
        params.hostname = "127.0.0.1";
        params.port = String(result.localPort);
        logger.info("Guacamole session routed through jump host tunnel", {
            sessionId, target: `${host}:${port}`, localPort: result.localPort,
        });
    }

    const recordingEnabled = await isRecordingEnabled(organizationId);

    if (recordingEnabled && session.auditLogId) {
        controlPlane.registerRecordingSession(sessionId, session.auditLogId);
    }

    const masterClient = new GuacdClient({
        sessionId,
        connectionSettings: {
            connection: { type: protocol, width: 1024, height: 768, dpi: 96, ...params },
            enableAudio: entry.config?.enableAudio !== false,
        },
        recordingEnabled,
        auditLogId: session.auditLogId,
        existingSocket: dataSocket,
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Master handshake timeout")), 15000);
        masterClient.onReadyCallback = (connectionId) => { clearTimeout(timeout); resolve(connectionId); };
        masterClient.onCloseCallback = (reason) => { clearTimeout(timeout); reject(new Error(`Master connection failed: ${reason}`)); };
        masterClient.connect();
    });

    SessionManager.setGuacReady(sessionId);

    SessionManager.setConnection(sessionId, {
        guacdClient: masterClient,
        dataSocket,
        type: "guac",
        auditLogId: session.auditLogId,
    });

    logger.info("Guacamole session prepared", { sessionId, protocol, target: host, port });
    return { success: true };
}

module.exports = {
    createConnectionForSession,
    createSFTPConnectionForSession,
    getSFTPTransferClient,
    getSFTPBackgroundClient,
    getSFTPAIClient,
    getSessionPassword,
    buildSSHParams,
    buildTelnetParams,
    createTelnetPromptLoginHandler,
    resolveJumpHosts,
};
