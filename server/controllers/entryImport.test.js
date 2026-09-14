const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Integration tests for folder paths, the bulk import and the export, against a throwaway SQLite
 * database. The server resolves its database relative to the working directory, so the whole suite
 * runs inside a temporary directory and requires the models only after chdir.
 */

let tempDir;
let originalCwd;
let accountId;
let folderController;
let entryController;

before(async () => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexterm-test-"));
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

    folderController = require("./folder");
    entryController = require("./entry");
});

after(async () => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* the database file may still be open */ }
});

describe("ensureFolderPath", () => {
    it("creates every missing level", async () => {
        const folder = await folderController.ensureFolderPath(accountId, "Prod/Web/EU");
        assert.equal(folder.name, "EU");

        const parent = await require("../models/Folder").findByPk(folder.parentId);
        assert.equal(parent.name, "Web");
    });

    it("reuses folders case-insensitively instead of duplicating them", async () => {
        const first = await folderController.ensureFolderPath(accountId, "Prod/Web/EU");
        const second = await folderController.ensureFolderPath(accountId, "prod/WEB/eu");
        assert.equal(second.id, first.id);

        const all = await require("../models/Folder").findAll({ where: { accountId } });
        assert.equal(all.filter(f => f.name.toLowerCase() === "prod").length, 1);
        assert.equal(all.filter(f => f.name.toLowerCase() === "web").length, 1);
    });

    it("accepts an array of segments", async () => {
        const folder = await folderController.ensureFolderPath(accountId, ["Prod", "Web", "APAC"]);
        assert.equal(folder.name, "APAC");
    });

    it("resolves below an explicit parent", async () => {
        const prod = await folderController.ensureFolderPath(accountId, "Prod");
        const nested = await folderController.ensureFolderPath(accountId, "Web/US", { parentId: prod.id });
        const parent = await require("../models/Folder").findByPk(nested.parentId);
        assert.equal(parent.name, "Web");
        assert.equal(parent.parentId, prod.id);
    });
});

describe("createFolder", () => {
    it("returns the existing folder instead of creating a sibling with the same name", async () => {
        const first = await folderController.createFolder(accountId, { name: "Dedupe" });
        const second = await folderController.createFolder(accountId, { name: "dedupe" });
        assert.equal(second.id, first.id);
    });
});

describe("createEntry with a folder path", () => {
    it("places the entry in the resolved folder and normalizes its protocols", async () => {
        const entry = await entryController.createEntry(accountId, {
            name: "path-entry",
            type: "server",
            folderPath: "Created/Deep",
            config: { ip: "10.0.0.1", protocol: "ssh", port: "2222" },
        });

        assert.ok(entry.id);
        assert.equal(entry.renderer, "terminal");
        assert.deepEqual(entry.config.protocols.ssh, { enabled: true, port: 2222 });
        assert.equal(entry.config.protocols.sftp.enabled, true);

        const folder = await require("../models/Folder").findByPk(entry.folderId);
        assert.equal(folder.name, "Deep");
    });

    it("derives the renderer from the primary protocol of a multi-protocol entry", async () => {
        const entry = await entryController.createEntry(accountId, {
            name: "multi-entry",
            type: "server",
            config: {
                ip: "10.0.0.2",
                protocol: "rdp",
                protocols: { ssh: { enabled: true, port: 22 }, rdp: { enabled: true, port: 3390 } },
            },
        });

        assert.equal(entry.renderer, "guac");
        assert.equal(entry.config.port, 3390);
    });
});

describe("bulk import and export", () => {
    it("imports rows, skips duplicates and reports per-row errors", async () => {
        const result = await entryController.bulkImportEntries(accountId, {
            entries: [
                { name: "bulk-a", host: "10.1.0.1", folderPath: "Bulk", protocols: ["ssh", "rdp"], primary: "ssh" },
                { name: "bulk-b", host: "10.1.0.2", folderPath: "Bulk", protocols: { vnc: { enabled: true, port: 5901 } } },
                { name: "bulk-a", host: "10.1.0.3", folderPath: "Bulk", protocols: ["ssh"] },
                { name: "bulk-bad", host: "10.1.0.4", protocols: ["ssh"], identities: ["missing-identity"] },
            ],
        });

        assert.equal(result.created, 2);
        assert.equal(result.skipped, 1);
        assert.equal(result.errors, 1);
        assert.match(result.results[3].message, /identity/i);
    });

    it("does not write anything during a dry run", async () => {
        const before = await require("../models/Entry").count();
        const result = await entryController.bulkImportEntries(accountId, {
            entries: [{ name: "dry-entry", host: "10.2.0.1", folderPath: "DryRun", protocols: ["ssh"] }],
            dryRun: true,
        });

        assert.equal(result.created, 1);
        assert.equal(await require("../models/Entry").count(), before);
    });

    it("exports entries in the shape the import consumes", async () => {
        const document_ = await entryController.exportEntries(accountId, {});
        assert.equal(document_.version, 1);

        const exported = document_.entries.find(entry => entry.name === "bulk-a");
        assert.equal(exported.host, "10.1.0.1");
        assert.equal(exported.folderPath, "Bulk");
        assert.equal(exported.primary, "ssh");
        assert.deepEqual(Object.keys(exported.protocols).sort(), ["rdp", "sftp", "ssh"]);
    });

    it("round-trips an export into a different folder", async () => {
        const document_ = await entryController.exportEntries(accountId, {});
        const result = await entryController.bulkImportEntries(accountId, {
            entries: document_.entries.map(entry => ({ ...entry, folderPath: `RoundTrip/${entry.folderPath || ""}` })),
        });

        assert.equal(result.errors, 0);
        assert.equal(result.created, document_.entries.length);

        const after = await entryController.exportEntries(accountId, {});
        const original = document_.entries.find(entry => entry.name === "bulk-a");
        const copy = after.entries.find(entry => entry.name === "bulk-a" && entry.folderPath.startsWith("RoundTrip"));
        assert.deepEqual({ ...copy, folderPath: null }, { ...original, folderPath: null });
    });

    it("skips every row when the same document is imported twice", async () => {
        const document_ = await entryController.exportEntries(accountId, {});
        const result = await entryController.bulkImportEntries(accountId, { entries: document_.entries });
        assert.equal(result.created, 0);
        assert.equal(result.skipped, document_.entries.length);
    });
});
