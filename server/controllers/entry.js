const Entry = require("../models/Entry");
const EntryIdentity = require("../models/EntryIdentity");
const Folder = require("../models/Folder");
const EntryTag = require("../models/EntryTag");
const Tag = require("../models/Tag");
const AuditLog = require("../models/AuditLog");
const { listFolders, ensureFolderPath, findFolderPath } = require("./folder");
const { hasOrganizationAccess, hasOrganizationPermission, hasAccountPermission, validateFolderAccess } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const { Op, fn, col, where: sqlWhere } = require("sequelize");
const Identity = require("../models/Identity");
const OrganizationMember = require("../models/OrganizationMember");
const { listIdentities } = require("./identity");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("./audit");
const logger = require("../utils/logger");
const { sendWakeOnLan } = require("../utils/wol");
const { reorderSiblings } = require("../utils/reposition");
const stateBroadcaster = require("../lib/StateBroadcaster");
const SessionManager = require("../lib/SessionManager");
const { PROTOCOLS, DEFAULT_PORTS, PROTOCOL_RENDERERS, normalizeServerConfig, isProtocolEnabled, getEnabledProtocols, getProtocolPort, getProtocolIdentities } = require("../utils/entryProtocols");
const { bulkImportEntryValidation } = require("../validations/server");

const validateEntryAccess = async (accountId, entry, errorMessage = "You don't have permission to access this entry", requiredPermission = null) => {
    if (!entry) return { code: 401, message: "Entry does not exist" };

    let { organizationId, accountId: ownerAccountId } = entry;
    if (entry.folderId) {
        const folder = await Folder.findByPk(entry.folderId);
        if (folder) ({ organizationId, accountId: ownerAccountId } = folder);
    }

    if (organizationId) {
        const allowed = requiredPermission
            ? await hasOrganizationPermission(accountId, organizationId, requiredPermission)
            : await hasOrganizationAccess(accountId, organizationId);
        if (!allowed) return { code: 403, message: `You don't have access to this organization's entry` };
    } else if (ownerAccountId && ownerAccountId !== accountId) {
        return { code: 403, message: errorMessage };
    } else if (requiredPermission && !(await hasAccountPermission(accountId, requiredPermission))) {
        return { code: 403, message: errorMessage };
    }
    return { valid: true, entry };
};

const validateIdentities = async (accountId, identities, organizationId) => {
    if (!identities || identities.length === 0) return { valid: true };

    const allAccessibleIdentities = await listIdentities(accountId);
    const accessibleIdentityIds = allAccessibleIdentities.map(identity => identity.id);

    const invalidIdentities = identities.filter(id => !accessibleIdentityIds.includes(id));

    if (invalidIdentities.length > 0) {
        return {
            valid: false,
            error: { code: 501, message: "One or more identities do not exist or you don't have access to them" },
        };
    }

    if (organizationId) {
        const hasAccess = await hasOrganizationAccess(accountId, organizationId);
        if (!hasAccess) {
            return { valid: false, error: { code: 403, message: "You don't have access to this organization" } };
        }
    }

    return { valid: true };
};

const validateJumpHosts = async (accountId, jumpHosts) => {
    if (!jumpHosts || jumpHosts.length === 0) return { valid: true };

    for (const jumpHostId of jumpHosts) {
        const jumpHostEntry = await Entry.findByPk(jumpHostId);
        
        if (!jumpHostEntry) {
            return {
                valid: false,
                error: { code: 404, message: `Jump host with ID ${jumpHostId} does not exist` }
            };
        }

        if (jumpHostEntry.type !== 'server' || !isProtocolEnabled(jumpHostEntry, 'ssh')) {
            return {
                valid: false,
                error: { code: 400, message: `Jump host ${jumpHostId} is not an SSH server` }
            };
        }

        const accessCheck = await validateEntryAccess(accountId, jumpHostEntry, "You don't have permission to use this jump host");
        if (!accessCheck.valid) {
            return { valid: false, error: accessCheck };
        }
    }

    return { valid: true };
};

/**
 * Turns an optional `folderPath` ("Prod/Web", case-insensitive, created on demand) into `folderId`.
 * When both are given the path is resolved below `folderId`.
 */
const resolveFolderPath = async (accountId, configuration) => {
    if (configuration.folderPath === undefined || configuration.folderPath === null) return null;

    const folderPath = configuration.folderPath;
    delete configuration.folderPath;

    const result = await ensureFolderPath(accountId, folderPath, {
        parentId: configuration.folderId || null,
        organizationId: configuration.organizationId || null,
    });
    if (result?.code) return result;
    if (result) {
        configuration.folderId = result.id;
        if (result.organizationId) configuration.organizationId = result.organizationId;
    }
    return null;
};

module.exports.createEntry = async (accountId, configuration) => {
    const pathError = await resolveFolderPath(accountId, configuration);
    if (pathError) return pathError;

    let folder = null;
    if (configuration.folderId) {
        folder = await validateFolderAccess(accountId, configuration.folderId, Permission.RESOURCES_MANAGE);
        if (!folder.valid) return folder.error;
    }

    if (!configuration.icon) {
        configuration.icon = "server";
    }

    if (configuration.config && (configuration.type ?? "server") === "server") {
        normalizeServerConfig(configuration.config, { type: "server" });
    }

    if (!configuration.renderer && configuration.config?.protocol) {
        configuration.renderer = PROTOCOL_RENDERERS[configuration.config.protocol] ?? configuration.renderer;
    }

    if (configuration.identities && configuration.identities.length > 0) {
        const validationResult = await validateIdentities(accountId, configuration.identities, configuration.organizationId);
        if (!validationResult.valid) return validationResult.error;
    }

    if (configuration.config?.jumpHosts && configuration.config.jumpHosts.length > 0) {
        const validationResult = await validateJumpHosts(accountId, configuration.config.jumpHosts);
        if (!validationResult.valid) return validationResult.error;
    }

    const organizationId = folder?.folder?.organizationId || configuration.organizationId || null;

    if (organizationId && organizationId !== folder?.folder?.organizationId
        && !(await hasOrganizationPermission(accountId, organizationId, Permission.RESOURCES_MANAGE))) {
        return { code: 403, message: "You don't have permission to manage resources in this organization" };
    }

    if (!organizationId && !(await hasAccountPermission(accountId, Permission.RESOURCES_MANAGE))) {
        return { code: 403, message: "You don't have permission to manage resources" };
    }

    const entry = await Entry.create({
        ...configuration,
        accountId: organizationId ? null : accountId,
        organizationId: organizationId,
        folderId: configuration.folderId || null,
    });

    if (configuration.identities && configuration.identities.length > 0) {
        for (let i = 0; i < configuration.identities.length; i++) {
            await EntryIdentity.create({
                entryId: entry.id,
                identityId: configuration.identities[i],
                isDefault: i === 0,
            });
        }
    }

    await createAuditLog({
        action: AUDIT_ACTIONS.ENTRY_CREATE,
        accountId,
        organizationId: folder?.folder?.organizationId || null,
        resource: RESOURCE_TYPES.ENTRY,
        resourceId: entry.id,
        details: {
            name: entry.name,
            folderId: entry.folderId,
            type: entry.type,
            protocol: entry.config?.protocol,
        }
    });

    logger.info(`Entry created`, { entryId: entry.id, name: entry.name, type: entry.type });

    stateBroadcaster.broadcast("ENTRIES", { accountId, organizationId: entry.organizationId });

    return entry;
};

module.exports.deleteEntry = async (accountId, entryId) => {
    const entry = await Entry.findByPk(entryId);
    const accessCheck = await validateEntryAccess(accountId, entry, "You don't have permission to delete this entry", Permission.RESOURCES_MANAGE);

    if (!accessCheck.valid) return accessCheck;

    await Entry.destroy({ where: { id: entryId } });

    await createAuditLog({
        action: AUDIT_ACTIONS.ENTRY_DELETE,
        accountId,
        organizationId: entry.organizationId,
        resource: RESOURCE_TYPES.ENTRY,
        resourceId: entryId,
        details: { name: entry.name, folderId: entry.folderId }
    });

    logger.info(`Entry deleted`, { entryId, name: entry.name });

    stateBroadcaster.broadcast("ENTRIES", { accountId, organizationId: entry.organizationId });

    return { success: true };
};

module.exports.editEntry = async (accountId, entryId, configuration) => {
    const entry = await Entry.findByPk(entryId);
    const accessCheck = await validateEntryAccess(accountId, entry, "You don't have permission to edit this entry", Permission.RESOURCES_MANAGE);

    if (!accessCheck.valid) return accessCheck;

    if (configuration.folderPath !== undefined) {
        const scoped = {
            folderPath: configuration.folderPath,
            folderId: configuration.folderId,
            organizationId: configuration.organizationId ?? entry.organizationId,
        };
        const pathError = await resolveFolderPath(accountId, scoped);
        if (pathError) return pathError;
        delete configuration.folderPath;
        if (scoped.folderId !== undefined) configuration.folderId = scoped.folderId;
    }

    if (configuration.folderId !== undefined && configuration.folderId !== null) {
        const folderCheck = await validateFolderAccess(accountId, configuration.folderId, Permission.RESOURCES_MANAGE);
        if (!folderCheck.valid) return folderCheck.error;
    }

    if (configuration.config && (configuration.type ?? entry.type) === "server") {
        normalizeServerConfig(configuration.config, { type: "server" });
    }

    if (configuration.config?.protocol) {
        configuration.renderer = PROTOCOL_RENDERERS[configuration.config.protocol] ?? configuration.renderer;
    }

    if (configuration.identities) {
        const validationResult = await validateIdentities(accountId, configuration.identities, entry.organizationId);
        if (!validationResult.valid) return validationResult.error;

        const accessibleIdentities = await listIdentities(accountId);
        const accessibleIdentityIds = new Set(accessibleIdentities.map(i => i.id));

        const existingEntryIdentities = await EntryIdentity.findAll({ where: { entryId } });
        const toDelete = existingEntryIdentities.filter(ei => accessibleIdentityIds.has(ei.identityId)).map(ei => ei.identityId);
        if (toDelete.length > 0) {
            await EntryIdentity.destroy({ where: { entryId, identityId: { [Op.in]: toDelete } } });
        }

        if (configuration.identities.length > 0) {
            const remainingIdentities = await EntryIdentity.findAll({ where: { entryId } });
            const hasDefault = remainingIdentities.some(ei => ei.isDefault);
            
            for (let i = 0; i < configuration.identities.length; i++) {
                await EntryIdentity.create({
                    entryId,
                    identityId: configuration.identities[i],
                    isDefault: !hasDefault && i === 0,
                });
            }
        }
        delete configuration.identities;
    }

    if (configuration.config?.jumpHosts !== undefined) {
        const validationResult = await validateJumpHosts(accountId, configuration.config.jumpHosts || []);
        if (!validationResult.valid) return validationResult.error;
    }

    delete configuration.organizationId;

    await Entry.update(configuration, { where: { id: entryId } });

    await createAuditLog({
        action: AUDIT_ACTIONS.ENTRY_UPDATE,
        accountId,
        organizationId: entry.organizationId,
        resource: RESOURCE_TYPES.ENTRY,
        resourceId: entryId,
        details: configuration
    });

    stateBroadcaster.broadcast("ENTRIES", { accountId, organizationId: entry.organizationId });

    return { success: true };
};

module.exports.getEntry = async (accountId, entryId) => {
    const entry = await Entry.findByPk(entryId);
    const accessCheck = await validateEntryAccess(accountId, entry);

    if (!accessCheck.valid) return accessCheck;

    const identities = await EntryIdentity.findAll({ where: { entryId }, order: [['isDefault', 'DESC']] });

    const accessibleIdentities = await listIdentities(accountId);
    const accessibleIdentityIds = new Set(accessibleIdentities.map(i => i.id));
    const filteredIdentityIds = identities
        .map(ei => ei.identityId)
        .filter(id => accessibleIdentityIds.has(id));

    return {
        ...entry,
        identities: filteredIdentityIds
    };
};

module.exports.listEntries = async (accountId) => {
    const folders = await listFolders(accountId, true);
    const memberships = await OrganizationMember.findAll({ where: { accountId, status: "active" } });
    const organizationIds = memberships.map(m => m.organizationId);

    const folderIds = [];
    const flattenFolders = (folders) => {
        folders.forEach(folder => {
            folderIds.push(folder.id);
            if (folder.entries && folder.entries.length > 0) flattenFolders(folder.entries);
        });
    };
    flattenFolders(folders);

    let entries = await Entry.findAll({
        where: {
            [Op.or]: [
                { folderId: { [Op.in]: folderIds } },
                { organizationId: { [Op.in]: organizationIds }, folderId: null },
                { accountId: accountId, folderId: null },
            ],
        },
        order: [["folderId", "ASC"], ["position", "ASC"]],
    });

    const entryIds = entries.map(e => e.id);
    const allEntryIdentities = await EntryIdentity.findAll({
        where: { entryId: { [Op.in]: entryIds } },
        order: [['isDefault', 'DESC']]
    });

    const allEntryTags = await EntryTag.findAll({
        where: { entryId: { [Op.in]: entryIds } }
    });

    const allTags = await Tag.findAll({
        where: { accountId: accountId }
    });

    const accessibleIdentities = await listIdentities(accountId);
    const accessibleIdentityIds = new Set(accessibleIdentities.map(i => i.id));

    const identitiesMap = new Map();
    allEntryIdentities.forEach(ei => {
        if (!accessibleIdentityIds.has(ei.identityId)) return;
        
        if (!identitiesMap.has(ei.entryId)) {
            identitiesMap.set(ei.entryId, []);
        }
        identitiesMap.get(ei.entryId).push(ei.identityId);
    });

    const tagsMap = new Map();
    allEntryTags.forEach(et => {
        if (!tagsMap.has(et.entryId)) {
            tagsMap.set(et.entryId, []);
        }
        const tag = allTags.find(t => t.id === et.tagId);
        if (tag) {
            tagsMap.get(et.entryId).push({ id: tag.id, name: tag.name, color: tag.color });
        }
    });

    const folderMap = new Map();
    const organizationMap = new Map();

    const rebuildFolderMap = (folders) => {
        folders.forEach(folder => {
            if (folder.type === 'organization') {
                organizationMap.set(parseInt(folder.id.split('-')[1]), folder);
                if (folder.entries && folder.entries.length > 0) rebuildFolderMap(folder.entries);
            } else {
                folderMap.set(folder.id, folder);
                if (folder.entries && folder.entries.length > 0) rebuildFolderMap(folder.entries);
            }
        });
    };
    rebuildFolderMap(folders);

    const buildEntryObject = (entry, identities, tags) => {
        const obj = {
            type: entry.type,
            id: entry.id,
            icon: entry.icon,
            name: entry.name,
            status: entry.status,
            position: entry.position,
            renderer: entry.renderer,
            tags: tags || [],
        };

        if (entry.type === 'server') {
            return {
                ...obj,
                identities: identities,
                protocol: entry.config?.protocol,
                protocols: getEnabledProtocols(entry),
                protocolIdentities: getProtocolIdentities(entry),
                ip: entry.config?.ip,
                port: entry.config?.protocol ? getProtocolPort(entry, entry.config.protocol) : entry.config?.port,
                macAddress: entry.config?.macAddress,
                wakeOnLanEnabled: entry.config?.wakeOnLanEnabled,
                notes: entry.config?.notes || "",
                // A short blurb of its own; notes are a Markdown scratchpad and never shown in the list.
                description: entry.config?.description || "",
                showDescriptionInList: Boolean(entry.config?.showDescriptionInList),
                // Per-protocol reachability from the status checker, or null when unknown / checks disabled.
                statusDetails: entry.statusDetails
                    ? { checkedAt: entry.statusDetails.checkedAt || null, protocols: entry.statusDetails.protocols || {} }
                    : null,
            };
        }

        if (entry.type?.startsWith('pve-')) {
            return { ...obj, integrationId: entry.integrationId };
        }

        return obj;
    };

    for (const entry of entries) {
        const identities = identitiesMap.get(entry.id) || [];
        const tags = tagsMap.get(entry.id) || [];
        const entryObject = buildEntryObject(entry, identities, tags);

        if (!entryObject) continue;

        if (entry.folderId) {
            const folder = folderMap.get(entry.folderId);
            if (folder) {
                folder.entries.push(entryObject);
            }
        } else if (entry.organizationId) {
            const organization = organizationMap.get(entry.organizationId);
            if (organization) {
                organization.entries.push(entryObject);
            }
        } else {
            folders.push(entryObject);
        }
    }

    return folders;
};

module.exports.duplicateEntry = async (accountId, entryId) => {
    const entry = await Entry.findByPk(entryId);
    if (!entry) return { code: 404, message: "Entry not found" };

    const accessCheck = await validateEntryAccess(accountId, entry, "You don't have permission to duplicate this entry", Permission.RESOURCES_MANAGE);
    if (!accessCheck.valid) return accessCheck;

    const identities = await EntryIdentity.findAll({ where: { entryId }, order: [['isDefault', 'DESC']] });

    const newEntry = await Entry.create({
        ...entry,
        id: undefined,
        name: entry.name + " (Copy)",
    });

    for (const identity of identities) {
        await EntryIdentity.create({
            entryId: newEntry.id,
            identityId: identity.identityId,
            isDefault: identity.isDefault,
        });
    }

    await createAuditLog({
        action: AUDIT_ACTIONS.ENTRY_CREATE,
        accountId,
        organizationId: entry.organizationId,
        resource: RESOURCE_TYPES.ENTRY,
        resourceId: newEntry.id,
        details: { name: newEntry.name, folderId: newEntry.folderId }
    });

    logger.info(`Entry duplicated`, { originalEntryId: entryId, newEntryId: newEntry.id, name: newEntry.name });

    stateBroadcaster.broadcast("ENTRIES", { accountId, organizationId: entry.organizationId });

    return newEntry;
};

module.exports.importSSHConfig = async (accountId, configuration) => {
    const { servers, folderId } = configuration;
    const folderCheck = await validateFolderAccess(accountId, folderId, Permission.RESOURCES_MANAGE);
    if (!folderCheck.valid) return folderCheck.error;

    const results = { imported: 0, skipped: 0, errors: 0, details: [] };
    const orgId = folderCheck.folder?.organizationId;

    for (const serverData of servers) {
        try {
            const existingEntry = await Entry.findOne({
                where: { name: serverData.name, folderId, organizationId: orgId || null }
            });

            if (existingEntry) {
                results.skipped++;
                results.details.push({ host: serverData.name, status: 'skipped', reason: 'Entry exists' });
                continue;
            }

            const config = normalizeServerConfig({
                ip: serverData.ip,
                port: serverData.port,
                protocol: "ssh",
                ...serverData.config,
            }, { type: "server" });

            const entry = await Entry.create({
                name: serverData.name,
                folderId,
                icon: "server",
                type: "server",
                renderer: "terminal",
                config,
                accountId: orgId ? null : accountId,
                organizationId: orgId || null,
            });

            if (serverData.identities && serverData.identities.length > 0) {
                for (let i = 0; i < serverData.identities.length; i++) {
                    await EntryIdentity.create({
                        entryId: entry.id,
                        identityId: serverData.identities[i],
                        isDefault: i === 0,
                    });
                }
            }

            await createAuditLog({
                action: AUDIT_ACTIONS.ENTRY_CREATE,
                accountId,
                organizationId: orgId || null,
                resource: RESOURCE_TYPES.ENTRY,
                resourceId: entry.id,
                details: { name: entry.name, folderId: entry.folderId, importSource: 'ssh-config' }
            });

            results.imported++;
            results.details.push({ host: serverData.name, status: 'imported', entryId: entry.id });
        } catch (error) {
            results.errors++;
            results.details.push({ host: serverData.name, status: 'error', reason: error.message });
        }
    }

    logger.info(`SSH config import completed`, { imported: results.imported, skipped: results.skipped, errors: results.errors });

    if (results.imported > 0) {
        stateBroadcaster.broadcast("ENTRIES", { accountId, organizationId: orgId });
    }

    return {
        message: `SSH config import: ${results.imported} imported, ${results.skipped} skipped, ${results.errors} errors`,
        ...results
    };
};

const BULK_IMPORT_TAG_COLOR = "#3b82f6";

/** Case-insensitive lookup of a server entry by name among the entries of one folder (or the scope root). */
const findEntryByName = (accountId, name, { folderId = null, organizationId = null }) => Entry.findOne({
    where: {
        folderId: folderId || null,
        type: "server",
        ...(organizationId ? { organizationId } : { organizationId: null, accountId }),
        [Op.and]: [sqlWhere(fn("lower", col("name")), String(name).trim().toLowerCase())],
    },
    order: [["position", "ASC"], ["id", "ASC"]],
});

/**
 * Resolves identity references (ids or names) of one import row against the caller's identities.
 * Names are matched case-insensitively; when several identities share a name the one in the target
 * organization wins, then a personal one. Returns `{ ids, unknown }`.
 */
const resolveIdentityReferences = (references, accessibleIdentities, organizationId) => {
    const ids = [];
    const unknown = [];
    for (const reference of references || []) {
        let match = null;
        if (typeof reference === "number") {
            match = accessibleIdentities.find(identity => identity.id === reference) || null;
        } else {
            const wanted = String(reference).trim().toLowerCase();
            const candidates = accessibleIdentities.filter(identity => identity.name?.trim().toLowerCase() === wanted);
            match = candidates.find(identity => organizationId && identity.organizationId === organizationId)
                || candidates.find(identity => !identity.organizationId)
                || candidates[0] || null;
        }
        if (!match) unknown.push(reference);
        else if (!ids.includes(match.id)) ids.push(match.id);
    }
    return { ids, unknown };
};

/**
 * Turns the `protocols` of an import row (a list of names, or a map with per-protocol port/identity)
 * into the `config.protocols` shape plus the primary protocol. Returns `{ protocols, primary }` or `{ error }`.
 */
const buildImportProtocols = (row, resolveIdentity) => {
    const protocols = {};
    const listed = [];
    const unknownIdentities = [];

    if (Array.isArray(row.protocols)) {
        for (const protocol of row.protocols) {
            protocols[protocol] = { enabled: true, port: DEFAULT_PORTS[protocol] };
            listed.push(protocol);
        }
    } else {
        for (const [protocol, value] of Object.entries(row.protocols)) {
            if (!PROTOCOLS.includes(protocol)) continue;
            const settings = typeof value === "object" && value !== null ? value : { enabled: Boolean(value) };
            const enabled = settings.enabled !== false;
            protocols[protocol] = { enabled, port: settings.port ?? DEFAULT_PORTS[protocol] };
            if (enabled) listed.push(protocol);
            if (settings.identity !== undefined && settings.identity !== null && settings.identity !== "") {
                const identityId = resolveIdentity(settings.identity);
                if (identityId) protocols[protocol].identityId = identityId;
                else unknownIdentities.push(settings.identity);
            }
        }
    }

    if (unknownIdentities.length > 0) return { error: `Unknown identity: ${unknownIdentities.join(", ")}` };
    if (listed.length === 0) return { error: "At least one protocol must be enabled" };

    const primary = row.primary || row.config?.protocol || listed[0];
    if (!listed.includes(primary)) return { error: `Primary protocol ${primary} is not enabled on this entry` };

    return { protocols, primary };
};

/**
 * Bulk import of server entries (POST /entries/import/bulk).
 *
 * Every row is validated, resolved and imported on its own: a bad row produces a per-row error and never
 * aborts the import. Folder paths are resolved below `folderId` (or the root of the personal list / the
 * organization), identities may be given by id or name, tags by name (missing tags are created), and a row
 * whose name already exists in its target folder is skipped unless `updateExisting` is set. With `dryRun`
 * nothing is written; the response then tells what would happen.
 */
module.exports.bulkImportEntries = async (accountId, { entries, folderId = null, organizationId = null, dryRun = false, updateExisting = false }) => {
    if (folderId) {
        const folderCheck = await validateFolderAccess(accountId, folderId, Permission.RESOURCES_MANAGE);
        if (!folderCheck.valid) return folderCheck.error;
        organizationId = folderCheck.folder.organizationId || null;
    }

    if (organizationId) {
        if (!(await hasOrganizationPermission(accountId, organizationId, Permission.RESOURCES_MANAGE))) {
            return { code: 403, message: "You don't have permission to manage resources in this organization" };
        }
    } else if (!(await hasAccountPermission(accountId, Permission.RESOURCES_MANAGE))) {
        return { code: 403, message: "You don't have permission to manage resources" };
    }

    const accessibleIdentities = await listIdentities(accountId);
    const tags = await Tag.findAll({ where: { accountId } });
    const tagsByName = new Map(tags.map(tag => [tag.name.trim().toLowerCase(), tag]));
    const folderCache = new Map();
    const seenNames = new Map();

    const resolveTags = async (names) => {
        const ids = [];
        for (const name of names || []) {
            const key = name.trim().toLowerCase();
            let tag = tagsByName.get(key);
            if (!tag) {
                tag = dryRun
                    ? { id: null, name: name.trim(), color: BULK_IMPORT_TAG_COLOR }
                    : await Tag.create({ accountId, name: name.trim(), color: BULK_IMPORT_TAG_COLOR });
                tagsByName.set(key, tag);
            }
            if (tag.id && !ids.includes(tag.id)) ids.push(tag.id);
        }
        return ids;
    };

    const folderPathKey = (folderPath) => {
        const segments = Array.isArray(folderPath) ? folderPath : String(folderPath || "").split(/[\/]+/);
        return segments.map(s => String(s).trim().toLowerCase()).filter(Boolean).join("/");
    };

    // Target folder of a row: the base folder, or `folderPath` below it (created on demand unless dryRun).
    const resolveTargetFolder = async (folderPath) => {
        const key = folderPathKey(folderPath);
        if (!key) return { folderId: folderId || null, missing: [] };
        if (folderCache.has(key)) return folderCache.get(key);

        let resolved;
        if (dryRun) {
            const found = await findFolderPath(accountId, folderPath, { parentId: folderId, organizationId });
            if (found?.code) return found;
            resolved = { folderId: found.missing.length ? null : found.folder?.id || null, missing: found.missing };
        } else {
            const folder = await ensureFolderPath(accountId, folderPath, { parentId: folderId, organizationId });
            if (folder?.code) return folder;
            resolved = { folderId: folder?.id || folderId || null, missing: [] };
        }
        folderCache.set(key, resolved);
        return resolved;
    };

    const importRow = async (row, index) => {
        const nameKey = `${folderPathKey(row.folderPath)}|${row.name.trim().toLowerCase()}`;
        if (seenNames.has(nameKey)) return { status: "skipped", message: `Duplicate of row ${seenNames.get(nameKey) + 1} in this import` };
        seenNames.set(nameKey, index);

        const identities = resolveIdentityReferences(row.identities, accessibleIdentities, organizationId);
        if (identities.unknown.length > 0) return { status: "error", message: `Unknown identity: ${identities.unknown.join(", ")}` };

        const built = buildImportProtocols(row, (reference) =>
            resolveIdentityReferences([reference], accessibleIdentities, organizationId).ids[0] || null);
        if (built.error) return { status: "error", message: built.error };

        // A protocol-specific identity has to be linked to the entry as well.
        for (const protocol of Object.values(built.protocols)) {
            if (protocol.identityId && !identities.ids.includes(protocol.identityId)) identities.ids.push(protocol.identityId);
        }

        const target = await resolveTargetFolder(row.folderPath);
        if (target?.code) return { status: "error", message: target.message };

        const { protocol: _protocol, protocols: _protocols, ...extraConfig } = row.config || {};

        // Jump hosts may reference other entries by name (that is how the export writes them).
        const unknownJumpHosts = [];
        if (Array.isArray(extraConfig.jumpHosts)) {
            const resolved = [];
            for (const reference of extraConfig.jumpHosts) {
                if (typeof reference === "number") { resolved.push(reference); continue; }
                const jumpHost = await Entry.findOne({
                    where: {
                        type: "server",
                        ...(organizationId ? { organizationId } : { organizationId: null, accountId }),
                        [Op.and]: [sqlWhere(fn("lower", col("name")), String(reference).trim().toLowerCase())],
                    },
                });
                if (jumpHost) resolved.push(jumpHost.id);
                else unknownJumpHosts.push(reference);
            }
            extraConfig.jumpHosts = resolved;
        }
        const config = normalizeServerConfig({
            ...extraConfig,
            ip: row.host,
            protocol: built.primary,
            protocols: built.protocols,
            ...(row.notes !== undefined ? { notes: row.notes } : {}),
            ...(row.description !== undefined ? { description: row.description, showDescriptionInList: true } : {}),
            ...(row.monitoring !== undefined ? { monitoringEnabled: row.monitoring } : {}),
        }, { type: "server" });

        const existing = target.missing.length > 0 ? null
            : await findEntryByName(accountId, row.name, { folderId: target.folderId, organizationId });

        if (existing && !updateExisting) {
            return { status: "skipped", id: existing.id, message: "An entry with this name already exists in the target folder" };
        }

        const tagIds = await resolveTags(row.tags);

        if (existing) {
            if (dryRun) return { status: "updated", id: existing.id };
            const result = await module.exports.editEntry(accountId, existing.id, {
                name: row.name,
                ...(row.icon ? { icon: row.icon } : {}),
                identities: identities.ids,
                config: { ...(existing.config || {}), ...config },
            });
            if (result?.code) return { status: "error", message: result.message };
            for (const tagId of tagIds) {
                await EntryTag.findOrCreate({ where: { entryId: existing.id, tagId }, defaults: { entryId: existing.id, tagId } });
            }
            return { status: "updated", id: existing.id };
        }

        if (dryRun) {
            return target.missing.length > 0
                ? { status: "created", message: `Folder ${target.missing.join("/")} will be created` }
                : { status: "created" };
        }

        const entry = await module.exports.createEntry(accountId, {
            name: row.name,
            type: "server",
            icon: row.icon || "server",
            folderId: target.folderId,
            organizationId,
            identities: identities.ids,
            config,
        });
        if (entry?.code) return { status: "error", message: entry.message };

        for (const tagId of tagIds) await EntryTag.create({ entryId: entry.id, tagId });
        return {
            status: "created",
            id: entry.id,
            ...(unknownJumpHosts.length ? { message: `Unknown jump host skipped: ${unknownJumpHosts.join(", ")}` } : {}),
        };
    };

    const results = [];
    const counters = { created: 0, updated: 0, skipped: 0, errors: 0 };

    for (let index = 0; index < entries.length; index++) {
        const raw = entries[index];
        const { error, value: row } = bulkImportEntryValidation.validate(raw, { errors: { wrap: { label: "" } }, allowUnknown: false });
        let outcome;
        if (error) {
            outcome = { status: "error", message: error.details[0]?.message || "Invalid row" };
        } else {
            try {
                outcome = await importRow(row, index);
            } catch (err) {
                logger.error("Bulk import row failed", { index, name: row.name, error: err.message });
                outcome = { status: "error", message: err.message };
            }
        }

        results.push({ index, name: typeof raw?.name === "string" ? raw.name : undefined, ...outcome });
        counters[outcome.status === "error" ? "errors" : outcome.status]++;
    }

    logger.info(`Bulk entry import ${dryRun ? "dry run " : ""}completed`, { accountId, organizationId, total: entries.length, ...counters });

    return {
        message: `Bulk import${dryRun ? " (dry run)" : ""}: ${counters.created} created, ${counters.updated} updated, ${counters.skipped} skipped, ${counters.errors} errors`,
        dryRun,
        updateExisting,
        total: entries.length,
        ...counters,
        results,
    };
};

module.exports.repositionEntry = async (accountId, entryId, { targetId, placement, folderId, organizationId }) => {
    const entryIdNum = parseInt(entryId);

    const entry = await Entry.findByPk(entryIdNum);
    const accessCheck = await validateEntryAccess(accountId, entry, "You don't have permission to reposition this entry", Permission.RESOURCES_MANAGE);

    if (!accessCheck.valid) return accessCheck;

    if (entry.integrationId && folderId !== undefined && folderId !== entry.folderId) {
        return { code: 403, message: "Integration resources cannot be moved out of their node folder" };
    }

    if (folderId !== undefined && folderId !== null) {
        const folderCheck = await validateFolderAccess(accountId, folderId, Permission.RESOURCES_MANAGE);
        if (!folderCheck.valid) return folderCheck.error;
    }

    let targetFolderId = folderId !== undefined ? folderId : entry.folderId;
    let targetOrganizationId = organizationId !== undefined ? organizationId : null;
    let targetAccountId = accountId;

    if (targetFolderId) {
        const folder = await Folder.findByPk(targetFolderId);
        if (folder) {
            targetOrganizationId = folder.organizationId || null;
            targetAccountId = folder.organizationId ? null : accountId;
        }
    } else {
        if (targetOrganizationId) {
            const hasAccess = await hasOrganizationPermission(accountId, targetOrganizationId, Permission.RESOURCES_MANAGE);
            if (!hasAccess) {
                return { code: 403, message: "You don't have permission to manage resources in this organization" };
            }
            targetAccountId = null;
        } else {
            targetOrganizationId = null;
            targetAccountId = accountId;
        }
    }

    const entries = await Entry.findAll({
        where: {
            folderId: targetFolderId,
            organizationId: targetOrganizationId,
            accountId: targetAccountId,
        },
        order: [["position", "ASC"]],
    });

    if (targetId !== null && targetId !== undefined && !entries.some(e => e.id === Number.parseInt(targetId))) {
        return { code: 404, message: "Target entry not found" };
    }

    await reorderSiblings(Entry, entries, entry, targetId, placement, {
        organizationId: targetOrganizationId,
        accountId: targetAccountId,
        folderId: targetFolderId,
    });

    const oldOrganizationId = entry.organizationId;
    if (oldOrganizationId !== targetOrganizationId) {
        const entryIdentities = await EntryIdentity.findAll({ where: { entryId: entryIdNum } });
        const identityIds = entryIdentities.map(ei => ei.identityId);
        
        if (identityIds.length > 0) {
            const oldOrgIdentities = await Identity.findAll({
                where: {
                    id: { [Op.in]: identityIds },
                    organizationId: oldOrganizationId,
                }
            });
            
            const oldOrgIdentityIds = oldOrgIdentities.map(i => i.id);
            if (oldOrgIdentityIds.length > 0) {
                await EntryIdentity.destroy({
                    where: {
                        entryId: entryIdNum,
                        identityId: { [Op.in]: oldOrgIdentityIds }
                    }
                });
                logger.info(`Removed ${oldOrgIdentityIds.length} organization identities from entry after move`, { entryId: entryIdNum, oldOrganizationId, targetOrganizationId });
            }
        }

        await SessionManager.removeAllByEntryId(entryIdNum);
    }

    await createAuditLog({
        action: AUDIT_ACTIONS.ENTRY_UPDATE,
        accountId,
        organizationId: entry.organizationId,
        resource: RESOURCE_TYPES.ENTRY,
        resourceId: entryIdNum,
        details: { action: 'reposition', targetId, placement, folderId: targetFolderId }
    });

    stateBroadcaster.broadcast("ENTRIES", { accountId, organizationId: entry.organizationId });
    if (targetOrganizationId && targetOrganizationId !== entry.organizationId) {
        stateBroadcaster.broadcast("ENTRIES", { organizationId: targetOrganizationId });
    }

    return { success: true };
};

module.exports.wakeEntry = async (accountId, entryId) => {
    const entry = await Entry.findByPk(entryId);
    const accessCheck = await validateEntryAccess(accountId, entry);
    if (!accessCheck.valid) return accessCheck;

    if (entry.type !== 'server') {
        return { code: 400, message: "Wake-On-LAN is only supported for server entries" };
    }

    const config = entry.config || {};
    const macAddress = config.macAddress;

    if (!macAddress) {
        return { code: 400, message: "No MAC address configured for this server" };
    }

    try {
        await sendWakeOnLan(macAddress, config.wolBroadcastAddress);
        return { success: true };
    } catch (error) {
        logger.error(`Failed to send Wake-On-LAN packet to ${macAddress}: ${error.message}`);
        return { code: 500, message: "Failed to send Wake-On-LAN packet" };
    }
};

module.exports.validateEntryAccess = validateEntryAccess;

module.exports.getRecentConnections = async (accountId, limit = 5) => {
    try {
        const memberships = await OrganizationMember.findAll({ 
            where: { accountId, status: "active" } 
        });
        const organizationIds = memberships.map(m => m.organizationId);

        const connectionActions = [
            AUDIT_ACTIONS.SSH_CONNECT,
            AUDIT_ACTIONS.SFTP_CONNECT,
            AUDIT_ACTIONS.PVE_CONNECT,
            AUDIT_ACTIONS.RDP_CONNECT,
            AUDIT_ACTIONS.VNC_CONNECT,
            AUDIT_ACTIONS.DEMO_CONNECT,
        ];

        const logs = await AuditLog.findAll({
            where: {
                action: { [Op.in]: connectionActions },
                resource: RESOURCE_TYPES.ENTRY,
                [Op.or]: [
                    { accountId, organizationId: null },
                    { organizationId: { [Op.in]: organizationIds } },
                ],
            },
            order: [["timestamp", "DESC"]],
            limit: limit * 3,
        });

        const seenEntries = new Set();
        const uniqueLogs = [];
        for (const log of logs) {
            if (!seenEntries.has(log.resourceId) && uniqueLogs.length < limit) {
                seenEntries.add(log.resourceId);
                uniqueLogs.push(log);
            }
        }

        const entryIds = uniqueLogs.map(log => log.resourceId);
        const entries = await Entry.findAll({
            where: { id: { [Op.in]: entryIds } },
        });
        const entryMap = new Map(entries.map(e => [e.id, e]));

        const allEntryIdentities = await EntryIdentity.findAll({
            where: { entryId: { [Op.in]: entryIds } },
            order: [['isDefault', 'DESC']]
        });
        const identitiesMap = new Map();
        allEntryIdentities.forEach(ei => {
            if (!identitiesMap.has(ei.entryId)) {
                identitiesMap.set(ei.entryId, []);
            }
            identitiesMap.get(ei.entryId).push(ei.identityId);
        });

        return uniqueLogs
            .map(log => {
                const entry = entryMap.get(log.resourceId);
                if (!entry) return null;

                return {
                    entryId: entry.id,
                    name: entry.name,
                    icon: entry.icon,
                    type: entry.type,
                    protocol: entry.config?.protocol || null,
                    connectionType: log.action,
                    timestamp: log.timestamp,
                    identities: identitiesMap.get(entry.id) || [],
                };
            })
            .filter(Boolean);
    } catch (error) {
        logger.error("Error getting recent connections", { error: error.message, accountId });
        return [];
    }
};

/** Config keys the export lifts to top-level fields; everything else is preserved under `config`. */
const EXPORT_LIFTED_CONFIG_KEYS = new Set(["ip", "port", "protocol", "protocols", "notes", "description", "showDescriptionInList", "monitoringEnabled"]);

/** Key order of an exported entry, so hand-edited files and fresh exports stay comparable. */
const EXPORT_KEY_ORDER = ["name", "host", "folderPath", "protocols", "primary", "identities", "tags", "description", "notes", "icon", "monitoring", "config"];

const orderExportKeys = (row) => Object.fromEntries(
    EXPORT_KEY_ORDER.filter(key => row[key] !== undefined).map(key => [key, row[key]]),
);

/**
 * Exports server entries as the document `POST /entries/import/bulk` consumes.
 *
 * Identities, tags and jump hosts are exported by NAME (never secrets), folders as a `folderPath`
 * relative to the export scope, and every remaining config key is preserved verbatim under `config`
 * so an export/import round trip keeps an entry identical. Integration-managed entries (Proxmox) are
 * skipped: they are synced from their source, not imported.
 */
module.exports.exportEntries = async (accountId, { folderId = null, organizationId = null } = {}) => {
    if (folderId) {
        const folderCheck = await validateFolderAccess(accountId, folderId);
        if (!folderCheck.valid) return folderCheck.error || folderCheck;
        organizationId = folderCheck.folder?.organizationId || null;
    } else if (organizationId && !(await hasOrganizationAccess(accountId, organizationId))) {
        return { code: 403, message: "You don't have access to this organization" };
    }

    const folders = await Folder.findAll({
        where: organizationId ? { organizationId } : { organizationId: null, accountId },
    });
    const folderById = new Map(folders.map(folder => [folder.id, folder]));

    // Folder path relative to the export scope; null when the entry sits outside it.
    const relativePath = (entryFolderId) => {
        const segments = [];
        let current = entryFolderId ? folderById.get(entryFolderId) : null;
        if (entryFolderId && !current) return null;
        while (current && current.id !== folderId) {
            segments.unshift(current.name);
            current = current.parentId ? folderById.get(current.parentId) : null;
            if (!current && folderId) return null;
        }
        if (folderId && !entryFolderId) return null;
        return segments.join("/");
    };

    const scopedFolderIds = folders
        .map(folder => folder.id)
        .filter(id => relativePath(id) !== null);

    const entries = await Entry.findAll({
        where: {
            type: "server",
            integrationId: null,
            ...(organizationId ? { organizationId } : { organizationId: null, accountId }),
            ...(folderId
                ? { folderId: { [Op.in]: scopedFolderIds.length ? scopedFolderIds : [-1] } }
                : {}),
        },
        order: [["folderId", "ASC"], ["position", "ASC"], ["id", "ASC"]],
    });

    const accessibleIdentities = await listIdentities(accountId);
    const identityNameById = new Map(accessibleIdentities.map(identity => [identity.id, identity.name]));
    const entryIds = entries.map(entry => entry.id);
    const entryIdentities = entryIds.length
        ? await EntryIdentity.findAll({ where: { entryId: { [Op.in]: entryIds } }, order: [["isDefault", "DESC"]] })
        : [];
    const entryTags = entryIds.length ? await EntryTag.findAll({ where: { entryId: { [Op.in]: entryIds } } }) : [];
    const allTags = await Tag.findAll({ where: { accountId } });
    const tagNameById = new Map(allTags.map(tag => [tag.id, tag.name]));

    const identitiesByEntry = new Map();
    for (const link of entryIdentities) {
        const name = identityNameById.get(link.identityId);
        if (!name) continue;
        if (!identitiesByEntry.has(link.entryId)) identitiesByEntry.set(link.entryId, []);
        identitiesByEntry.get(link.entryId).push({ id: link.identityId, name });
    }

    const tagsByEntry = new Map();
    for (const link of entryTags) {
        const name = tagNameById.get(link.tagId);
        if (!name) continue;
        if (!tagsByEntry.has(link.entryId)) tagsByEntry.set(link.entryId, []);
        tagsByEntry.get(link.entryId).push(name);
    }

    const entryNameById = new Map(entries.map(entry => [entry.id, entry.name]));

    const exported = [];
    for (const entry of entries) {
        const path = relativePath(entry.folderId);
        if (path === null) continue;

        const config = { ...(entry.config || {}) };
        const linkedIdentities = identitiesByEntry.get(entry.id) || [];
        const identityNames = linkedIdentities.map(identity => identity.name);

        const protocols = {};
        for (const protocol of getEnabledProtocols(entry)) {
            const settings = { enabled: true, port: getProtocolPort(entry, protocol) };
            const identityId = getProtocolIdentities(entry)[protocol];
            const identityName = identityId ? identityNameById.get(identityId) : null;
            if (identityName) settings.identity = identityName;
            protocols[protocol] = settings;
        }

        const extraConfig = Object.fromEntries(
            Object.entries(config).filter(([key]) => !EXPORT_LIFTED_CONFIG_KEYS.has(key)),
        );
        // Jump hosts travel as entry names so they survive an import into a fresh installation.
        if (Array.isArray(extraConfig.jumpHosts)) {
            extraConfig.jumpHosts = extraConfig.jumpHosts.map(id => entryNameById.get(id) || id);
        }

        exported.push(orderExportKeys({
            name: entry.name,
            host: config.ip || "",
            folderPath: path || undefined,
            protocols,
            primary: config.protocol || getEnabledProtocols(entry)[0],
            identities: identityNames.length ? identityNames : undefined,
            tags: tagsByEntry.get(entry.id),
            description: config.description || undefined,
            notes: config.notes || undefined,
            icon: entry.icon || undefined,
            monitoring: config.monitoringEnabled === undefined ? undefined : Boolean(config.monitoringEnabled),
            config: Object.keys(extraConfig).length ? extraConfig : undefined,
        }));
    }

    logger.info("Entries exported", { accountId, organizationId, folderId, count: exported.length });

    return { version: 1, exportedAt: new Date().toISOString(), entries: exported };
};
