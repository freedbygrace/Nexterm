const SshCertificateAuthority = require("../models/SshCertificateAuthority");
const { generateCaKeyPair, signUserCertificate } = require("../utils/sshCertificate");
const { fingerprint } = require("../utils/sshKeygen");
const { hasOrganizationAccess, hasOrganizationPermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const logger = require("../utils/logger");

/** How long a certificate signed for one connection stays valid. */
const CERTIFICATE_LIFETIME_MS = 10 * 60 * 1000;
/** Backdated so a target whose clock runs a little behind still accepts it. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const scopeWhere = (accountId, organizationId) => organizationId
    ? { organizationId }
    : { organizationId: null, accountId };

/** Model instances, not plain rows: the database sets query.raw globally and the key is a getter. */
const findAuthority = (where) => SshCertificateAuthority.findOne({ where, order: [["id", "ASC"]], raw: false });

const toPublicAuthority = (authority) => authority && {
    id: authority.id,
    organizationId: authority.organizationId,
    publicKey: authority.publicKey,
    fingerprint: fingerprint(authority.publicKey),
    createdAt: authority.createdAt,
};

/** The scope's CA, created the first time something needs it. */
module.exports.getOrCreateCertificateAuthority = async (accountId, organizationId = null) => {
    const existing = await findAuthority(scopeWhere(accountId, organizationId));
    if (existing) return existing;

    const { privateKey, publicKey } = generateCaKeyPair({
        comment: organizationId ? `nexterm-org-${organizationId}-user-ca` : `nexterm-account-${accountId}-user-ca`,
    });
    const authority = await SshCertificateAuthority.create({
        accountId: organizationId ? null : accountId,
        organizationId,
        publicKey,
        privateKey,
    });

    logger.info("SSH certificate authority created", { accountId, organizationId, authorityId: authority.id });
    return authority;
};

/** The public half of the caller's (or an organization's) CA, or null when it has none yet. */
module.exports.getCertificateAuthority = async (accountId, organizationId = null) => {
    if (organizationId && !(await hasOrganizationAccess(accountId, organizationId)))
        return { code: 403, message: "No access to this organization" };
    // A plain row: model instances read the ISO dates utils/database.js writes as Invalid Date.
    const authority = await SshCertificateAuthority.findOne({
        where: scopeWhere(accountId, organizationId),
        order: [["id", "ASC"]],
        attributes: ["id", "organizationId", "publicKey", "createdAt"],
    });
    return toPublicAuthority(authority);
};

module.exports.toPublicAuthority = toPublicAuthority;

/**
 * Whether the caller may mint access through a scope's CA.
 *
 * A host that trusts an organization's CA accepts a certificate for any user name the CA signs. So
 * whoever links an identity to it, renames a linked identity (its name is the certificate's
 * principal), or creates a certificate enrollment token can reach every such host - without anything
 * being installed on them. In an organization that takes the right to manage the organization, not
 * just its identities. A personal CA is its owner's alone.
 */
module.exports.canUseCertificateAuthority = async (accountId, organizationId) =>
    !organizationId || hasOrganizationPermission(accountId, organizationId, Permission.ORG_MANAGE);

module.exports.CA_PERMISSION_MESSAGE = "Using the organization's certificate authority requires permission to manage the organization";

/**
 * Signs a certificate for one connection: valid for minutes, for the identity's user name only.
 *
 * @returns {Promise<string|null>} the `...-cert-v01@openssh.com` line, or null when the identity has
 *          no CA or no usable public key.
 */
module.exports.issueCertificate = async (identity, userPublicKey) => {
    if (!identity?.certificateAuthorityId || !identity.username || !userPublicKey) return null;

    const authority = await SshCertificateAuthority.findByPk(identity.certificateAuthorityId, { raw: false });
    if (!authority) return null;

    const now = Date.now();
    return signUserCertificate({
        caPrivateKey: authority.privateKey,
        userPublicKey,
        principals: [identity.username],
        keyId: `nexterm identity ${identity.id}`,
        validAfter: new Date(now - CLOCK_SKEW_MS),
        validBefore: new Date(now + CERTIFICATE_LIFETIME_MS),
        comment: `nexterm-${identity.id}`,
    });
};
