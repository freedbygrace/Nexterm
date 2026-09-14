const Identity = require('../models/Identity');
const EntryIdentity = require('../models/EntryIdentity');
const { listIdentities } = require('../controllers/identity');

const { CREDENTIALLESS_PROTOCOLS, getPrimaryProtocol, getProtocolIdentityId } = require('./entryProtocols');

/**
 * @param {string|null} protocol - the protocol the session will use; defaults to the entry's primary protocol.
 */
const resolveIdentity = async (entry, identityId, directIdentity = null, accountId = null, protocol = null) => {
    const effectiveProtocol = protocol || getPrimaryProtocol(entry);
    const requiresIdentity = !entry.type?.startsWith('pve-') && !CREDENTIALLESS_PROTOCOLS.has(effectiveProtocol);

    if (directIdentity) {
        return {
            id: null,
            name: 'Direct Connection',
            username: directIdentity.username,
            type: directIdentity.type,
            isDirect: true,
            directCredentials: {
                password: directIdentity.password,
                "ssh-key": directIdentity.sshKey,
                passphrase: directIdentity.passphrase,
                "ssh-cert": directIdentity.sshCertificate,
            }
        };
    }

    const accessibleIds = accountId ? new Set((await listIdentities(accountId)).map(i => i.id)) : null;

    if (identityId) {
        const identity = await Identity.findByPk(identityId);
        if (!identity) return { identity: null, requiresIdentity };
        if (accessibleIds && !accessibleIds.has(identity.id)) {
            return { identity: null, requiresIdentity, accessDenied: true };
        }
        // Nexterm holds the key, so a disabled identity is refused here rather than handed to the engine.
        if (identity.disabled) return { identity: null, requiresIdentity, disabled: true };
        return identity;
    }

    const entryIdentities = await EntryIdentity.findAll({
        where: { entryId: entry.id },
        order: [['isDefault', 'DESC']]
    });

    // A protocol may name its own default identity (e.g. the Windows account for RDP); it must still be
    // attached to the entry and accessible to the caller, otherwise the entry default applies.
    const protocolIdentityId = getProtocolIdentityId(entry, effectiveProtocol);
    if (protocolIdentityId && entryIdentities.some(ei => ei.identityId === protocolIdentityId)
        && (!accessibleIds || accessibleIds.has(protocolIdentityId))) {
        const identity = await Identity.findByPk(protocolIdentityId);
        if (identity && !identity.disabled) return identity;
    }

    // A disabled identity is skipped rather than used; if every candidate is disabled the caller is told.
    let sawDisabled = false;
    for (const ei of entryIdentities) {
        if (accessibleIds && !accessibleIds.has(ei.identityId)) continue;
        const identity = await Identity.findByPk(ei.identityId);
        if (!identity) continue;
        if (identity.disabled) { sawDisabled = true; continue; }
        return identity;
    }

    return { identity: null, requiresIdentity, ...(sawDisabled ? { disabled: true } : {}) };
};

module.exports = { resolveIdentity };
