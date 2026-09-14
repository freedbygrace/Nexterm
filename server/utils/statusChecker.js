const Entry = require("../models/Entry");
const { checkServerStatusBatch } = require("../hooks/status/portHook");
const { checkPVEStatus } = require("../hooks/status/pveHook");
const { getMonitoringSettingsInternal } = require("../controllers/monitoring");
const controlPlane = require("../lib/controlPlane/ControlPlaneServer");
const stateBroadcaster = require("../lib/StateBroadcaster");
const logger = require("./logger");

let statusCheckInterval = null;
let isRunning = false;
let currentSettings = null;

const DEFAULT_CHECK_INTERVAL = 30000;
const DEFAULT_BATCH_SIZE = 10;

const executeByType = async (entry) => {
    const type = entry.type;

    if (type === "pve-qemu" || type === "pve-lxc" || type === "pve-shell") {
        return await checkPVEStatus(entry);
    }

    return null;
};

const checkEntryWithTimeout = async (entry, timeout) => {
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
            resolve({ id: entry.id, status: null });
        }, timeout);
    });

    const checkPromise = executeByType(entry)
        .then(status => ({ id: entry.id, status }))
        .catch(() => ({ id: entry.id, status: null }));

    return Promise.race([checkPromise, timeoutPromise]);
};


const processBatch = async (entries, batchTimeout) => {
    logger.verbose(`Processing status check batch`, { batchSize: entries.length });
    const checks = entries.map(entry => checkEntryWithTimeout(entry, batchTimeout));

    const results = await Promise.all(checks);

    const validResults = results.filter(result => result.status !== null);
    logger.verbose(`Batch processing complete`, {
        total: results.length,
        valid: validResults.length,
        timeout: results.length - validResults.length
    });

    return validResults;
};

const listAllServers = async () => {
    try {
        const entries = await Entry.findAll({
            where: {
                type: ["server", "pve-qemu", "pve-lxc", "pve-shell"],
            },
            attributes: ["id", "type", "name", "config", "integrationId", "accountId", "organizationId", "status", "statusDetails"],
        });

        return entries;
    } catch (error) {
        logger.error(`Error fetching entries for status check`, { error: error.message });
        return [];
    }
};

/** Per-entry opt-out (server dialog > Settings > Reachability checks). */
const isStatusCheckEnabled = (entry) => entry.config?.statusCheckEnabled !== false;

const sameProtocols = (a, b) => {
    const left = a || {}, right = b || {};
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every(key => left[key] === right[key]);
};

/** A result that clears a stale status (entry is not checked any more). */
const clearedResult = (entry) => ({ id: entry.id, status: null, statusDetails: null });

/**
 * Writes the results to the database and notifies connected clients about entries whose
 * status or per-protocol reachability actually changed. A result may carry `statusDetails`
 * (server entries) or only `status` (PVE entries, whose statusDetails stay untouched).
 */
const updateStatuses = async (entries, results) => {
    if (results.length === 0) return;

    const entryMap = new Map(entries.map(e => [e.id, e]));
    const updates = [];
    const changed = [];

    for (const result of results) {
        const entry = entryMap.get(result.id);
        if (!entry) continue;

        const hasDetails = result.statusDetails !== undefined;
        const statusChanged = (entry.status ?? null) !== (result.status ?? null);
        const detailsChanged = hasDetails && (
            Boolean(entry.statusDetails) !== Boolean(result.statusDetails)
            || !sameProtocols(entry.statusDetails?.protocols, result.statusDetails?.protocols)
        );

        if (statusChanged || detailsChanged) changed.push(entry);

        // Fresh probe results are always persisted so `checkedAt` stays current; everything else only on change.
        const isFreshProbe = hasDetails && result.statusDetails !== null;
        if (!isFreshProbe && !statusChanged && !detailsChanged) continue;

        const payload = { status: result.status };
        if (hasDetails) payload.statusDetails = result.statusDetails;
        updates.push(Entry.update(payload, { where: { id: result.id } }));
    }

    try {
        if (updates.length > 0) {
            logger.verbose(`Updating entry statuses`, { count: updates.length, changed: changed.length });
            await Promise.all(updates);
        }
    } catch (error) {
        logger.error(`Error updating entry statuses`, { error: error.message });
    }

    if (changed.length === 0) return;

    logger.debug(`Entry status changes`, {
        entries: changed.map(e => ({ id: e.id, status: results.find(r => r.id === e.id)?.status })),
    });

    // One ENTRIES broadcast per affected scope (personal list or organization).
    const scopes = new Map();
    for (const entry of changed) {
        const key = `${entry.accountId || ""}:${entry.organizationId || ""}`;
        if (!scopes.has(key)) scopes.set(key, { accountId: entry.accountId, organizationId: entry.organizationId });
    }
    for (const scope of scopes.values()) stateBroadcaster.broadcast("ENTRIES", scope);
};

const runStatusCheck = async () => {
    if (isRunning) {
        logger.debug(`Status check already running, skipping cycle`);
        return;
    }

    isRunning = true;

    try {
        currentSettings = await getMonitoringSettingsInternal();

        if (!currentSettings || !currentSettings.statusCheckerEnabled) {
            logger.verbose(`Status checker is disabled, setting all entries to online`);
            const entries = await listAllServers();
            if (entries.length > 0) {
                await updateStatuses(entries, entries.map(e => ({ id: e.id, status: "online", statusDetails: null })));
            }
            isRunning = false;
            return;
        }

        logger.verbose(`Starting status check cycle`);

        const entries = await listAllServers();

        if (entries.length === 0) {
            logger.verbose(`No entries to check`);
            isRunning = false;
            return;
        }

        const batchTimeout = (currentSettings.connectionTimeout || 30) * 1000;

        const serverEntries = entries.filter(e => e.type === "server");
        const pveEntries = entries.filter(e => e.type !== "server");

        logger.info(`Checking status for ${entries.length} entries`, {
            servers: serverEntries.length,
            pve: pveEntries.length,
        });

        const allResults = [];

        if (serverEntries.length > 0) {
            const optedOut = serverEntries.filter(e => !isStatusCheckEnabled(e));
            const toCheck = serverEntries.filter(isStatusCheckEnabled);
            allResults.push(...optedOut.map(clearedResult));

            if (toCheck.length > 0) {
                if (!controlPlane.hasEngine()) {
                    // The engine performs the TCP probes; without one the last result would only go stale.
                    logger.verbose(`No engine connected, skipping server reachability checks`);
                    allResults.push(...toCheck.map(clearedResult));
                } else {
                    try {
                        const batchResults = await checkServerStatusBatch(toCheck, batchTimeout);
                        allResults.push(...batchResults);
                    } catch (error) {
                        logger.warn(`Server reachability check failed`, { error: error.message });
                    }
                }
            }
        }

        if (pveEntries.length > 0) {
            const batchSize = currentSettings.batchSize || DEFAULT_BATCH_SIZE;
            for (let i = 0; i < pveEntries.length; i += batchSize) {
                const batch = pveEntries.slice(i, i + batchSize);
                const batchResults = await processBatch(batch, batchTimeout);
                allResults.push(...batchResults);
            }
        }

        await updateStatuses(entries, allResults);
        logger.info(`Status check cycle completed`, {
            totalChecked: entries.length,
            updated: allResults.length
        });
    } catch (error) {
        logger.error(`Error in status check cycle`, { error: error.message });
    } finally {
        isRunning = false;
    }
}

const startStatusChecker = async (interval = null) => {
    if (statusCheckInterval !== null) {
        logger.warn(`Status checker already running`);
        return;
    }

    currentSettings = await getMonitoringSettingsInternal();
    const checkInterval = interval || (currentSettings?.statusInterval ? currentSettings.statusInterval * 1000 : DEFAULT_CHECK_INTERVAL);

    logger.system(`Starting status checker`, { interval: checkInterval, batchSize: currentSettings?.batchSize || DEFAULT_BATCH_SIZE });

    runStatusCheck();

    statusCheckInterval = setInterval(runStatusCheck, checkInterval);
};

const stopStatusChecker = () => {
    if (statusCheckInterval !== null) {
        logger.system(`Stopping status checker`);
        clearInterval(statusCheckInterval);
        statusCheckInterval = null;
    }
};

module.exports = {
    startStatusChecker,
    stopStatusChecker,
};
