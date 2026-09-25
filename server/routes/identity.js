const { Router } = require("express");
const { validateSchema } = require("../utils/schema");
const { listIdentities, createIdentity, deleteIdentity, updateIdentity, moveIdentityToOrganization, setIdentityDisabled } = require("../controllers/identity");
const { createIdentityValidation, updateIdentityValidation, moveIdentityValidation, setIdentityDisabledValidation } = require("../validations/identity");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("../controllers/audit");
const { getCertificateAuthority } = require("../controllers/certificateAuthority");

const app = Router();

/**
 * GET /identity/list
 * @summary List User Identities
 * @description Retrieves a list of all authentication identities (SSH keys, credentials) available to the authenticated user. Returns both personal identities and organization identities the user has access to.
 * @tags Identity
 * @produces application/json
 * @security BearerAuth
 * @return {array} 200 - List of user identities with scope indication (personal/organization)
 */
app.get("/list", async (req, res) => {
    res.json(await listIdentities(req.user.id));
});

/**
 * GET /identity/certificate-authority
 * @summary SSH Certificate Authority
 * @description The public key of the caller's personal SSH user CA, or an organization's. Hosts that list it in sshd's
 * `TrustedUserCAKeys` accept identities linked to the CA: Nexterm signs a certificate valid for ten minutes for every
 * connection. Returns null until the CA is first used; the private key is never returned.
 * @tags Identity
 * @produces application/json
 * @security BearerAuth
 * @param {number} organizationId.query - The organization whose CA to return instead of the personal one
 * @return {object} 200 - Public key, fingerprint and creation date, or null
 */
app.get("/certificate-authority", async (req, res) => {
    const organizationId = req.query.organizationId ? Number.parseInt(req.query.organizationId, 10) : null;
    const result = await getCertificateAuthority(req.user.id, organizationId);
    if (result?.code) return res.status(result.code).json(result);
    res.json(result);
});

/**
 * PUT /identity
 * @summary Create New Identity
 * @description Creates a new authentication identity for server connections. Can be personal (bound to account) or organizational (shared with organization members).
 * @tags Identity
 * @produces application/json
 * @security BearerAuth
 * @param {CreateIdentity} request.body.required - Identity configuration including type, credentials, and optional organizationId
 * @return {object} 200 - Identity successfully created with new identity ID
 * @return {object} 400 - Invalid identity configuration
 */
app.put("/", async (req, res) => {
    if (validateSchema(res, createIdentityValidation, req.body)) return;

    const identity = await createIdentity(req.user.id, req.body);
    if (identity?.code) return res.json(identity);

    await createAuditLog({
        accountId: req.user.id,
        organizationId: req.body.organizationId || null,
        action: AUDIT_ACTIONS.IDENTITY_CREATE,
        resource: RESOURCE_TYPES.IDENTITY,
        resourceId: identity.id,
        details: {
            identityName: req.body.name,
            identityType: req.body.type,
            scope: req.body.organizationId ? 'organization' : 'personal',
        },
        ipAddress: req.ip,
        userAgent: req.headers?.["user-agent"],
    });

    res.json({ message: "Identity got successfully created", id: identity.id });
});

/**
 * DELETE /identity/{identityId}
 * @summary Delete Identity
 * @description Permanently removes an authentication identity. Personal identities can only be deleted by the owner. Organization identities can be deleted by any organization member.
 * @tags Identity
 * @produces application/json
 * @security BearerAuth
 * @param {string} identityId.path.required - The unique identifier of the identity to delete
 * @return {object} 200 - Identity successfully deleted
 * @return {object} 404 - Identity not found
 */
app.delete("/:identityId", async (req, res) => {
    const result = await deleteIdentity(req.user.id, req.params.identityId);
    if (result?.code) return res.json(result);

    await createAuditLog({
        accountId: req.user.id,
        organizationId: result.identity?.organizationId || null,
        action: AUDIT_ACTIONS.IDENTITY_DELETE,
        resource: RESOURCE_TYPES.IDENTITY,
        resourceId: req.params.identityId,
        details: {
            identityName: result.identity?.name,
            identityType: result.identity?.type,
        },
        ipAddress: req.ip,
        userAgent: req.headers?.["user-agent"],
    });

    res.json({ message: "Identity got successfully deleted" });
});

/**
 * PATCH /identity/{identityId}
 * @summary Update Identity
 * @description Updates an existing authentication identity's configuration such as credentials or connection settings.
 * @tags Identity
 * @produces application/json
 * @security BearerAuth
 * @param {string} identityId.path.required - The unique identifier of the identity to update
 * @param {UpdateIdentity} request.body.required - Updated identity configuration fields
 * @return {object} 200 - Identity successfully updated
 * @return {object} 404 - Identity not found
 */
app.patch("/:identityId", async (req, res) => {
    if (validateSchema(res, updateIdentityValidation, req.body)) return;

    const result = await updateIdentity(req.user.id, req.params.identityId, req.body);
    if (result?.code) return res.json(result);

    await createAuditLog({
        accountId: req.user.id,
        organizationId: result.identity?.organizationId || null,
        action: AUDIT_ACTIONS.IDENTITY_UPDATE,
        resource: RESOURCE_TYPES.IDENTITY,
        resourceId: req.params.identityId,
        details: {
            identityName: result.identity?.name,
            identityType: result.identity?.type,
            updatedFields: Object.keys(req.body).filter(key => !['password', 'sshKey', 'passphrase', 'sshCertificate'].includes(key)),
        },
        ipAddress: req.ip,
        userAgent: req.headers?.["user-agent"],
    });

    res.json({ message: "Identity got successfully edited" });
});

/**
 * POST /identity/{identityId}/disabled
 * @summary Disable or Enable an Identity
 * @description Disables an identity without deleting it. Nexterm holds the private key, so a disabled identity can no
 * longer open a session, act as a jump host or run a command; its credentials, attachments and history stay intact and
 * it can be enabled again.
 * @tags Identity
 * @produces application/json
 * @security BearerAuth
 * @param {string} identityId.path.required - The unique identifier of the identity
 * @param {SetIdentityDisabled} request.body.required - Whether the identity should be disabled
 * @return {object} 200 - New state of the identity
 * @return {object} 403 - Not authorized to manage this identity
 * @return {object} 404 - Identity not found
 */
app.post("/:identityId/disabled", async (req, res) => {
    if (validateSchema(res, setIdentityDisabledValidation, req.body)) return;

    const result = await setIdentityDisabled(req.user.id, req.params.identityId, req.body.disabled);
    if (result?.code) return res.json(result);

    await createAuditLog({
        accountId: req.user.id,
        organizationId: result.identity?.organizationId || null,
        action: AUDIT_ACTIONS.IDENTITY_UPDATE,
        resource: RESOURCE_TYPES.IDENTITY,
        resourceId: req.params.identityId,
        details: {
            identityName: result.identity?.name,
            identityType: result.identity?.type,
            disabled: req.body.disabled,
        },
        ipAddress: req.ip,
        userAgent: req.headers?.["user-agent"],
    });

    res.json({ message: req.body.disabled ? "Identity got successfully disabled" : "Identity got successfully enabled", identity: result.identity });
});

/**
 * POST /identity/{identityId}/move
 * @summary Move Identity to Organization
 * @description Moves a personal identity to an organization, making it accessible to all organization members. Only the identity owner can perform this action.
 * @tags Identity
 * @produces application/json
 * @security BearerAuth
 * @param {string} identityId.path.required - The unique identifier of the personal identity to move
 * @param {MoveIdentity} request.body.required - Target organization configuration
 * @return {object} 200 - Identity successfully moved to organization
 * @return {object} 403 - Not authorized to move this identity or access target organization
 * @return {object} 404 - Identity not found
 */
app.post("/:identityId/move", async (req, res) => {
    if (validateSchema(res, moveIdentityValidation, req.body)) return;

    const result = await moveIdentityToOrganization(req.user.id, req.params.identityId, req.body.organizationId);
    if (result?.code) return res.json(result);

    await createAuditLog({
        accountId: req.user.id,
        organizationId: req.body.organizationId,
        action: AUDIT_ACTIONS.IDENTITY_UPDATE,
        resource: RESOURCE_TYPES.IDENTITY,
        resourceId: req.params.identityId,
        details: {
            identityName: result.identity?.name,
            targetOrganizationId: req.body.organizationId,
        },
        ipAddress: req.ip,
        userAgent: req.headers?.["user-agent"],
    });

    res.json({ message: "Identity successfully moved to organization", identity: result.identity });
});

module.exports = app;
