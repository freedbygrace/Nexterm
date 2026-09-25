const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Nexterm holds the private keys, so disabling an identity is what actually cuts a host off. These
 * tests cover the choke point every session goes through, against a throwaway SQLite database: the
 * server resolves it relative to the working directory, so everything runs inside a temp directory
 * and the models are required only after chdir.
 */

let tempDir;
let originalCwd;
let accountId;
let Identity;
let Entry;
let EntryIdentity;
let resolveIdentity;
let identityController;
let enrollmentController;

const createIdentity = async (name, disabled = false) =>
    Identity.create({ name, type: "ssh", username: "root", accountId, disabled });

const createEntry = async (name, config = {}) =>
    Entry.create({ name, type: "server", accountId, config: { ip: "10.0.0.1", protocol: "ssh", ...config } });

const attach = (entry, identity, isDefault = false) =>
    EntryIdentity.create({ entryId: entry.id, identityId: identity.id, isDefault });

before(async () => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexterm-identity-test-"));
    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    process.chdir(tempDir);
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const db = require("../utils/database");
    await db.authenticate();

    const MigrationRunner = require("../utils/migrationRunner");
    await new MigrationRunner().runMigrations();

    const Account = require("../models/Account");
    const account = await Account.create({
        username: "tester",
        password: "$2b$10$0000000000000000000000000000000000000000000000000000",
        firstName: "Test",
        lastName: "Account",
        role: "admin",
    });
    accountId = account.id;

    Identity = require("../models/Identity");
    Entry = require("../models/Entry");
    EntryIdentity = require("../models/EntryIdentity");
    ({ resolveIdentity } = require("./identityResolver"));
    identityController = require("../controllers/identity");
    enrollmentController = require("../controllers/enrollment");
});

after(async () => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* the database file may still be open */ }
});

describe("resolveIdentity with a disabled identity", () => {
    it("refuses an identity that was asked for by id", async () => {
        const identity = await createIdentity("explicit", true);
        const entry = await createEntry("explicit-host");
        await attach(entry, identity);

        const result = await resolveIdentity(entry, identity.id, null, null, "ssh");

        assert.equal(result.identity, null);
        assert.equal(result.disabled, true);
    });

    it("still returns an enabled identity", async () => {
        const identity = await createIdentity("enabled");
        const entry = await createEntry("enabled-host");
        await attach(entry, identity);

        const result = await resolveIdentity(entry, identity.id, null, null, "ssh");

        assert.equal(result.id, identity.id);
        assert.ok(!result.disabled);
    });

    it("reports why an entry whose only identity is disabled has none", async () => {
        const identity = await createIdentity("only-one", true);
        const entry = await createEntry("single-identity-host");
        await attach(entry, identity, true);

        const result = await resolveIdentity(entry, null, null, null, "ssh");

        assert.equal(result.identity, null);
        assert.equal(result.disabled, true);
    });

    it("skips a disabled identity in favour of one that still works", async () => {
        const disabled = await createIdentity("retired", true);
        const usable = await createIdentity("current");
        const entry = await createEntry("two-identity-host");
        await attach(entry, disabled, true);
        await attach(entry, usable);

        const result = await resolveIdentity(entry, null, null, null, "ssh");

        assert.equal(result.id, usable.id);
    });

    it("does not use a protocol's own identity once it is disabled", async () => {
        const rdpIdentity = await createIdentity("windows-account", true);
        const fallback = await createIdentity("fallback");
        const entry = await createEntry("rdp-host", {
            protocols: { rdp: { enabled: true, port: 3389, identityId: null } },
        });
        // The identity id is only known after creation, so the protocol map is filled in here.
        await entry.update({
            config: { ...entry.config, protocols: { rdp: { enabled: true, port: 3389, identityId: rdpIdentity.id } } },
        });
        await attach(entry, rdpIdentity);
        await attach(entry, fallback);

        const result = await resolveIdentity(entry, null, null, null, "rdp");

        assert.equal(result.id, fallback.id);
    });

    it("leaves a direct connection alone", async () => {
        const entry = await createEntry("direct-host");
        const result = await resolveIdentity(entry, null, { username: "root", type: "password", password: "x" }, null, "ssh");

        assert.equal(result.isDirect, true);
    });
});

describe("setIdentityDisabled", () => {
    it("stops and restores the identity", async () => {
        const identity = await createIdentity("toggled");
        const entry = await createEntry("toggled-host");
        await attach(entry, identity);

        await identityController.setIdentityDisabled(accountId, identity.id, true);
        assert.equal((await resolveIdentity(entry, identity.id, null, null, "ssh")).disabled, true);

        await identityController.setIdentityDisabled(accountId, identity.id, false);
        assert.equal((await resolveIdentity(entry, identity.id, null, null, "ssh")).id, identity.id);
    });

    it("is reported by the identity list", async () => {
        const identity = await createIdentity("listed");
        await identityController.setIdentityDisabled(accountId, identity.id, true);

        const listed = (await identityController.listIdentities(accountId)).find(i => i.id === identity.id);
        assert.equal(listed.disabled, true);
    });
});

describe("revokeEnrollmentToken", () => {
    it("disables the key it installed so enrolled hosts can no longer be reached", async () => {
        const token = await enrollmentController.createEnrollmentToken(accountId, { name: "revoked-batch" });
        const entry = await createEntry("enrolled-host");
        await attach(entry, { id: token.identityId });

        const result = await enrollmentController.revokeEnrollmentToken(accountId, token.id);
        assert.equal(result.identityDisabled, true);

        const resolved = await resolveIdentity(entry, token.identityId, null, null, "ssh");
        assert.equal(resolved.identity, null);
        assert.equal(resolved.disabled, true);
    });

    it("keeps the key usable when asked to", async () => {
        const token = await enrollmentController.createEnrollmentToken(accountId, { name: "kept-batch" });
        const entry = await createEntry("kept-host");
        await attach(entry, { id: token.identityId });

        const result = await enrollmentController.revokeEnrollmentToken(accountId, token.id, { keepIdentity: true });
        assert.equal(result.identityDisabled, false);

        const resolved = await resolveIdentity(entry, token.identityId, null, null, "ssh");
        assert.equal(resolved.id, token.identityId);
    });

    it("reports the key state in the token list", async () => {
        const tokens = await enrollmentController.listEnrollmentTokens(accountId);

        assert.equal(tokens.find(t => t.name === "revoked-batch").identityDisabled, true);
        assert.equal(tokens.find(t => t.name === "kept-batch").identityDisabled, false);
    });
});

describe("certificate authority", () => {
    const { generateSshKeyPair } = require("./sshKeygen");

    const certificateFields = (line) => {
        const blob = Buffer.from(line.split(" ")[1], "base64");
        let offset = 0;
        const string = () => { const n = blob.readUInt32BE(offset); const v = blob.subarray(offset + 4, offset + 4 + n); offset += 4 + n; return v; };
        const uint64 = () => { const v = blob.readBigUInt64BE(offset); offset += 8; return v; };
        string(); string(); string(); string(); // type, nonce, e, n
        uint64(); offset += 4;                   // serial, type
        const keyId = string().toString();
        const principals = string();
        const validAfter = Number(uint64()) * 1000;
        const validBefore = Number(uint64()) * 1000;
        return { keyId, principal: principals.subarray(4).toString(), validAfter, validBefore };
    };

    it("signs a short-lived certificate for every connection of a linked identity", async () => {
        const key = generateSshKeyPair({ modulusLength: 2048 });
        const created = await identityController.createIdentity(accountId, {
            name: "ca-linked", username: "deploy", type: "ssh", sshKey: key.privateKey, useCertificateAuthority: true,
        });

        const first = await identityController.getIdentityCredentials(created.id);
        const second = await identityController.getIdentityCredentials(created.id);
        assert.match(first["ssh-cert"], /^ssh-rsa-cert-v01@openssh\.com /);
        assert.notEqual(first["ssh-cert"], second["ssh-cert"], "a new certificate per connection");

        const cert = certificateFields(first["ssh-cert"]);
        assert.equal(cert.principal, "deploy");
        assert.equal(cert.keyId, `nexterm identity ${created.id}`);
        assert.ok(cert.validAfter <= Date.now() && cert.validBefore > Date.now());
        assert.ok(cert.validBefore - Date.now() <= 10 * 60 * 1000 + 5000, "valid for minutes, not days");

        const listed = (await identityController.listIdentities(accountId)).find(i => i.id === created.id);
        assert.equal(listed.useCertificateAuthority, true);
    });

    it("uses one CA per scope and none once unlinked", async () => {
        const key = generateSshKeyPair({ modulusLength: 2048 });
        const created = await identityController.createIdentity(accountId, {
            name: "ca-toggled", username: "ops", type: "ssh", sshKey: key.privateKey, useCertificateAuthority: true,
        });
        const { getCertificateAuthority } = require("../controllers/certificateAuthority");
        const authority = await getCertificateAuthority(accountId);
        assert.match(authority.publicKey, /^ssh-ed25519 /);
        assert.equal((await Identity.findByPk(created.id)).certificateAuthorityId, authority.id);

        await identityController.updateIdentity(accountId, created.id, { useCertificateAuthority: false });
        const creds = await identityController.getIdentityCredentials(created.id);
        assert.equal(creds["ssh-cert"], undefined);
    });
});

describe("organization certificate authority permissions", () => {
    const { generateSshKeyPair } = require("./sshKeygen");
    let memberId;
    let organizationId;

    before(async () => {
        const Account = require("../models/Account");
        const Organization = require("../models/Organization");
        const OrganizationMember = require("../models/OrganizationMember");
        const member = await Account.create({
            username: "member", password: "$2b$10$0000000000000000000000000000000000000000000000000000",
            firstName: "Org", lastName: "Member", role: "user",
        });
        memberId = member.id;
        const organization = await Organization.create({ name: "ca-org" });
        organizationId = organization.id;
        await OrganizationMember.create({ organizationId, accountId: memberId, role: "member", status: "active", invitedBy: accountId });
        await OrganizationMember.create({ organizationId, accountId, role: "owner", status: "active", invitedBy: accountId });
    });

    const newIdentity = (who, overrides = {}) => identityController.createIdentity(who, {
        name: `org-${Date.now()}-${Math.random()}`, username: "root", type: "ssh",
        sshKey: generateSshKeyPair({ modulusLength: 2048 }).privateKey, organizationId, ...overrides,
    });

    it("lets a member manage identities but not link them to the CA", async () => {
        const plain = await newIdentity(memberId);
        assert.ok(plain.id, "a plain organization identity is fine");

        const linked = await newIdentity(memberId, { useCertificateAuthority: true });
        assert.equal(linked.code, 403);

        const update = await identityController.updateIdentity(memberId, plain.id, { useCertificateAuthority: true });
        assert.equal(update.code, 403);
    });

    it("stops a member renaming a linked identity, which would change the certificate's principal", async () => {
        const linked = await newIdentity(accountId, { useCertificateAuthority: true });
        assert.ok(linked.id, "an owner may link");

        const rename = await identityController.updateIdentity(memberId, linked.id, { username: "admin" });
        assert.equal(rename.code, 403);

        const harmless = await identityController.updateIdentity(memberId, linked.id, { name: "renamed label only" });
        assert.equal(harmless.success, true);
    });

    it("keeps certificate enrollment tokens to those who manage the organization", async () => {
        const denied = await enrollmentController.createEnrollmentToken(memberId, { name: "m", organizationId, method: "certificate" });
        assert.equal(denied.code, 403);

        const keyToken = await enrollmentController.createEnrollmentToken(memberId, { name: "m2", organizationId, method: "key" });
        assert.ok(keyToken.token, "key tokens are unchanged");
    });
});

describe("enrollment callback", () => {
    const Entry = require("../models/Entry");
    const entryConfig = async (id) => (await Entry.findByPk(id)).config;

    it("adds RDP when the host reports it listening", async () => {
        const token = await enrollmentController.createEnrollmentToken(accountId, { name: "rdp-batch", maxUses: null });
        const result = await enrollmentController.completeEnrollment(token.token,
            { hostname: "win-rdp-01", address: "10.1.1.5", port: 22, rdpPort: 3390 }, "10.1.1.5");
        const config = await entryConfig(result.entryId);

        assert.equal(config.protocols.rdp.enabled, true);
        assert.equal(config.protocols.rdp.port, 3390);
        assert.equal(config.protocols.ssh.enabled, true);
        assert.equal(config.protocol, "ssh", "SSH stays primary: the enrollment key cannot log in over RDP");
    });

    it("leaves RDP out when the host does not report it", async () => {
        const token = await enrollmentController.createEnrollmentToken(accountId, { name: "no-rdp", maxUses: null });
        const result = await enrollmentController.completeEnrollment(token.token,
            { hostname: "linux-01", address: "10.1.1.6", port: 22 }, "10.1.1.6");
        assert.equal((await entryConfig(result.entryId)).protocols.rdp, undefined);
    });

    it("keeps protocols and settings added by hand when a host enrolls again", async () => {
        const token = await enrollmentController.createEnrollmentToken(accountId, { name: "rerun", maxUses: null });
        const first = await enrollmentController.completeEnrollment(token.token,
            { hostname: "mixed-01", address: "10.1.1.7", port: 22 }, "10.1.1.7");

        const entry = await Entry.findByPk(first.entryId, { raw: false });
        await entry.update({ config: {
            ...entry.config,
            protocol: "vnc",
            protocols: { ...entry.config.protocols, vnc: { enabled: true, port: 5901, identityId: 777 } },
        } });

        const again = await enrollmentController.completeEnrollment(token.token,
            { hostname: "mixed-01", address: "10.1.1.8", port: 2222, rdpPort: 3389 }, "10.1.1.8");
        assert.equal(again.entryId, first.entryId);

        const config = await entryConfig(first.entryId);
        assert.deepEqual(config.protocols.vnc, { enabled: true, port: 5901, identityId: 777 }, "hand-added protocol kept");
        assert.equal(config.protocol, "vnc", "chosen primary kept");
        assert.equal(config.protocols.ssh.port, 2222, "detected port updated");
        assert.equal(config.protocols.rdp.port, 3389, "newly detected RDP added");
        assert.equal(config.ip, "10.1.1.8");
    });
});
