const controlPlane = require("../../lib/controlPlane/ControlPlaneServer");
const { getEnabledProtocols, getProtocolPort } = require("../../utils/entryProtocols");

/**
 * Builds the TCP targets for one server entry: one per enabled protocol, deduplicated by host:port
 * (SFTP on the SSH port, or FTP + FTPS on 21, share a single probe). Returns
 * `{ targets: [{ id, host, port }], protocolTargets: { [protocol]: targetId } }`.
 */
const buildEntryTargets = (entry) => {
    const host = entry.config?.ip;
    const targets = [];
    const protocolTargets = {};
    if (!host) return { targets, protocolTargets };

    const targetByPort = new Map();
    for (const protocol of getEnabledProtocols(entry)) {
        if (protocol === "demo") continue;
        const port = Number(getProtocolPort(entry, protocol));
        if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;

        let targetId = targetByPort.get(port);
        if (!targetId) {
            targetId = `${entry.id}:${protocol}`;
            targetByPort.set(port, targetId);
            targets.push({ id: targetId, host, port });
        }
        protocolTargets[protocol] = targetId;
    }

    return { targets, protocolTargets };
};

/**
 * Probes every enabled protocol port of the given server entries through the engine.
 * Resolves to `[{ id, status, statusDetails }]` where `status` is "online" when at least one
 * protocol answered and `statusDetails` is `{ checkedAt, protocols: { ssh: "online", rdp: "offline" } }`.
 */
const checkServerStatusBatch = async (entries, timeoutMs = 2000) => {
    if (!controlPlane.hasEngine()) throw new Error("No engine connected");

    const perEntry = entries.map(entry => ({ entry, ...buildEntryTargets(entry) }));
    const allTargets = perEntry.flatMap(item => item.targets);

    const onlineTargets = new Set();
    if (allTargets.length > 0) {
        const result = await controlPlane.portCheck(allTargets, timeoutMs);
        for (const target of result.entries || []) {
            if (target.online) onlineTargets.add(target.id);
        }
    }

    const checkedAt = new Date().toISOString();
    return perEntry.map(({ entry, protocolTargets }) => {
        const protocols = {};
        let anyOnline = false;
        for (const [protocol, targetId] of Object.entries(protocolTargets)) {
            const online = onlineTargets.has(targetId);
            protocols[protocol] = online ? "online" : "offline";
            if (online) anyOnline = true;
        }
        return {
            id: entry.id,
            status: anyOnline ? "online" : "offline",
            statusDetails: { checkedAt, protocols },
        };
    });
};

module.exports = { checkServerStatusBatch, buildEntryTargets };
