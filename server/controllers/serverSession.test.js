const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

/**
 * A session's `type` is what the client renders by. Clients send a protocol name in the same request
 * field, and "ssh" or "rdp" coming back as a renderer showed "Unknown renderer: ssh" after a reload.
 */
describe("sessionTypeFor", () => {
    process.env.ENCRYPTION_KEY ||= "0".repeat(64);
    const { sessionTypeFor } = require("./serverSession");

    it("never turns a protocol name into a renderer", () => {
        for (const protocol of ["ssh", "telnet", "rdp", "vnc", "spice"]) {
            assert.equal(sessionTypeFor(protocol, protocol), null, protocol);
        }
    });

    it("keeps real renderer overrides", () => {
        assert.equal(sessionTypeFor("web", "ssh"), "web");
        assert.equal(sessionTypeFor("sftp", "sftp"), "sftp");
        assert.equal(sessionTypeFor("terminal", "ssh"), "terminal");
    });

    it("opens every file protocol in the file manager", () => {
        for (const protocol of ["sftp", "ftp", "ftps"]) assert.equal(sessionTypeFor(protocol, protocol), "sftp");
    });

    it("falls back to nothing for a plain connect", () => {
        assert.equal(sessionTypeFor(null, "ssh"), null);
        assert.equal(sessionTypeFor(undefined, "rdp"), null);
    });
});
