const crypto = require("crypto");
const { Op, fn, col, where: sqlWhere } = require("sequelize");
const EnrollmentToken = require("../models/EnrollmentToken");
const Identity = require("../models/Identity");
const Credential = require("../models/Credential");
const Entry = require("../models/Entry");
const { generateSshKeyPair, fingerprint } = require("../utils/sshKeygen");
const { buildEnrollmentScript } = require("../utils/enrollmentScript");
const { normalizeServerConfig } = require("../utils/entryProtocols");
const { hasOrganizationPermission, hasAccountPermission, validateFolderAccess } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("./audit");
const { createEntry } = require("./entry");
const stateBroadcaster = require("../lib/StateBroadcaster");
const logger = require("../utils/logger");

const TOKEN_BYTES = 32;
const MAX_LIFETIME_DAYS = 365;

const generateToken = () => crypto.randomBytes(TOKEN_BYTES).toString("base64url");

/** Everything about a token except the secret itself and the private key. */
const toPublicToken = (token, publicKey) => ({
    id: token.id,
    name: token.name,
    organizationId: token.organizationId,
    identityId: token.identityId,
    folderId: token.folderId,
    username: token.username,
    maxUses: token.maxUses,
    uses: token.uses,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    createEntries: token.createEntries,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
    ...(publicKey ? { publicKey, fingerprint: fingerprint(publicKey) } : {}),
});

/** Why a token cannot be used right now, or null when it is usable. */
const tokenUnusableReason = (token) => {
    if (!token) return "Unknown enrollment token";
    if (token.revokedAt) return "This enrollment token has been revoked";
    if (token.expiresAt && new Date(token.expiresAt) <= new Date()) return "This enrollment token has expired";
    if (token.maxUses !== null && token.uses >= token.maxUses) return "This enrollment token has been used up";
    return null;
};

/** Model instances, not plain rows: the database sets query.raw globally (see utils/database.js). */
const findToken = (where) => EnrollmentToken.findOne({ where, raw: false });

const publicKeyOf = async (identityId) => {
    const credential = await Credential.findOne({ where: { identityId, type: "ssh-public" } });
    return credential?.secret || null;
};

/**
 * Creates an enrollment token together with the key pair it installs.
 *
 * The private key is stored as a normal identity (encrypted at rest) and never leaves Nexterm; the
 * public key is kept alongside it so the script can be served without touching the private key.
 */
module.exports.createEnrollmentToken = async (accountId, config) => {
    const organizationId = config.organizationId || null;

    if (organizationId) {
        if (!(await hasOrganizationPermission(accountId, organizationId, Permission.IDENTITIES_MANAGE)))
            return { code: 403, message: "You don't have permission to manage this organization's identities" };
    } else if (!(await hasAccountPermission(accountId, Permission.IDENTITIES_MANAGE))) {
        return { code: 403, message: "You don't have permission to manage identities" };
    }

    if (config.folderId) {
        const folderCheck = await validateFolderAccess(accountId, config.folderId, Permission.RESOURCES_MANAGE);
        if (!folderCheck.valid) return folderCheck.error;
    }

    const lifetimeDays = config.lifetimeDays === undefined ? 7 : config.lifetimeDays;
    if (lifetimeDays !== null && (lifetimeDays <= 0 || lifetimeDays > MAX_LIFETIME_DAYS))
        return { code: 400, message: `Lifetime must be between 1 and ${MAX_LIFETIME_DAYS} days` };

    const username = (config.username || "root").trim();
    const name = config.name.trim();

    const identity = await Identity.create({
        name: `${name} (enrollment)`,
        type: "ssh",
        username,
        accountId: organizationId ? null : accountId,
        organizationId,
    });

    const keyPair = generateSshKeyPair({ comment: `nexterm-${identity.id}` });
    await Credential.create({ identityId: identity.id, type: "ssh-key", secret: keyPair.privateKey });
    // Kept so the script can be served, and the fingerprint shown, without decrypting the private key.
    await Credential.create({ identityId: identity.id, type: "ssh-public", secret: keyPair.publicKey });

    const token = await EnrollmentToken.create({
        token: generateToken(),
        name,
        accountId,
        organizationId,
        identityId: identity.id,
        folderId: config.folderId || null,
        username,
        // null is a deliberate "no limit", so only an absent value falls back to a single use.
        maxUses: config.maxUses === undefined ? 1 : config.maxUses,
        expiresAt: lifetimeDays === null ? null : new Date(Date.now() + lifetimeDays * 24 * 60 * 60 * 1000),
        createEntries: config.createEntries !== false,
    });

    await createAuditLog({
        accountId,
        organizationId,
        action: AUDIT_ACTIONS.IDENTITY_CREATE,
        resource: RESOURCE_TYPES.IDENTITY,
        resourceId: identity.id,
        details: { name: identity.name, enrollment: true, fingerprint: keyPair.fingerprint },
    });

    logger.info("Enrollment token created", { accountId, organizationId, tokenId: token.id, identityId: identity.id });

    // The secret is returned exactly once, when it is created.
    return { ...toPublicToken(token, keyPair.publicKey), token: token.token };
};

module.exports.listEnrollmentTokens = async (accountId, organizationId = null) => {
    const tokens = await EnrollmentToken.findAll({
        where: organizationId ? { organizationId } : { organizationId: null, accountId },
        order: [["createdAt", "DESC"]],
    });

    return Promise.all(tokens.map(async token => toPublicToken(token, await publicKeyOf(token.identityId))));
};

module.exports.revokeEnrollmentToken = async (accountId, tokenId) => {
    const token = await EnrollmentToken.findByPk(tokenId, { raw: false });
    if (!token) return { code: 404, message: "Enrollment token not found" };

    if (token.organizationId) {
        if (!(await hasOrganizationPermission(accountId, token.organizationId, Permission.IDENTITIES_MANAGE)))
            return { code: 403, message: "You don't have permission to manage this organization's identities" };
    } else if (token.accountId !== accountId) {
        return { code: 403, message: "You don't have permission to revoke this enrollment token" };
    }

    await token.update({ revokedAt: new Date() });
    logger.info("Enrollment token revoked", { accountId, tokenId });
    return { success: true };
};

/** Serves the shell script for a token, or an error when the token cannot be used. */
module.exports.getEnrollmentScript = async (tokenValue, origin) => {
    const token = await findToken({ token: tokenValue });
    const reason = tokenUnusableReason(token);
    if (reason) return { code: token ? 410 : 404, message: reason };

    const publicKey = await publicKeyOf(token.identityId);
    if (!publicKey) return { code: 500, message: "Enrollment key is missing" };

    return {
        script: buildEnrollmentScript({
            publicKey,
            callbackUrl: `${origin}/api/enroll/${token.token}/callback`,
            username: token.username,
            createEntries: token.createEntries,
        }),
    };
};

/**
 * Records a host that ran the enrollment script.
 *
 * Called by the target with no credentials other than the token, so the payload is treated as
 * untrusted: only a name, address, OS string and port are taken, and an entry is created (or an
 * existing one with the same name updated) with the token's identity attached.
 */
module.exports.completeEnrollment = async (tokenValue, report, requestIp) => {
    const token = await findToken({ token: tokenValue });
    const reason = tokenUnusableReason(token);
    if (reason) return { code: token ? 410 : 404, message: reason };

    // The address the host reported, falling back to where the request came from.
    const address = (report.address || "").trim() || (requestIp || "").replace(/^::ffff:/, "");
    const name = (report.hostname || "").trim() || address || `host-${Date.now()}`;
    const port = Number.isInteger(report.port) && report.port > 0 && report.port <= 65535 ? report.port : 22;

    await token.update({ uses: token.uses + 1, lastUsedAt: new Date() });

    if (!token.createEntries) {
        logger.info("Host enrolled (no entry created)", { tokenId: token.id, name });
        return { success: true, message: "Key installed" };
    }

    if (!address) return { code: 400, message: "No address to create a connection with" };

    const config = normalizeServerConfig({
        ip: address,
        protocol: "ssh",
        protocols: { ssh: { enabled: true, port }, sftp: { enabled: true, port } },
    }, { type: "server" });

    const existing = await Entry.findOne({
        raw: false,
        where: {
            type: "server",
            folderId: token.folderId || null,
            ...(token.organizationId ? { organizationId: token.organizationId } : { organizationId: null, accountId: token.accountId }),
            [Op.and]: [sqlWhere(fn("lower", col("name")), name.toLowerCase())],
        },
    });

    if (existing) {
        await existing.update({ config: { ...existing.config, ...config } });
        await require("../models/EntryIdentity").findOrCreate({
            where: { entryId: existing.id, identityId: token.identityId },
            defaults: { entryId: existing.id, identityId: token.identityId, isDefault: false },
        });
        stateBroadcaster.broadcast("ENTRIES", { accountId: token.accountId, organizationId: token.organizationId });
        logger.info("Host re-enrolled", { tokenId: token.id, entryId: existing.id, name });
        return { success: true, entryId: existing.id, message: "Connection updated" };
    }

    const entry = await createEntry(token.accountId, {
        name,
        type: "server",
        icon: "server",
        folderId: token.folderId || null,
        organizationId: token.organizationId,
        identities: [token.identityId],
        config: { ...config, ...(report.os ? { notes: String(report.os).slice(0, 200) } : {}) },
    });

    if (entry?.code) return entry;

    await createAuditLog({
        accountId: token.accountId,
        organizationId: token.organizationId,
        action: AUDIT_ACTIONS.ENTRY_CREATE,
        resource: RESOURCE_TYPES.ENTRY,
        resourceId: entry.id,
        details: { name, enrolled: true, address },
    });

    logger.info("Host enrolled", { tokenId: token.id, entryId: entry.id, name, address });
    return { success: true, entryId: entry.id, message: "Connection created" };
};
