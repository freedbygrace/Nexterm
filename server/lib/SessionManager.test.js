const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const SessionManager = require("./SessionManager");

/** Companion sessions: the SFTP session a terminal's docked file panel runs on. */
describe("companion sessions", () => {
    const create = (configuration) => SessionManager.create(9001, 42, { renderer: "terminal", ...configuration });

    it("are closed together with the session they serve", async () => {
        const terminal = create({});
        const files = create({ renderer: "sftp", companionOf: terminal.sessionId });
        const unrelated = create({});

        await SessionManager.remove(terminal.sessionId);
        // The cascade is not awaited by remove(); let it run.
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(SessionManager.get(files.sessionId), null);
        assert.ok(SessionManager.get(unrelated.sessionId), "other sessions are left alone");
        await SessionManager.remove(unrelated.sessionId);
    });

    it("can be closed on their own without touching the terminal", async () => {
        const terminal = create({});
        const files = create({ renderer: "sftp", companionOf: terminal.sessionId });

        await SessionManager.remove(files.sessionId);
        assert.ok(SessionManager.get(terminal.sessionId));
        await SessionManager.remove(terminal.sessionId);
    });
});
