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
