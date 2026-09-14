const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildEnrollmentScript } = require("./enrollmentScript");

const PUBLIC_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABtest nexterm-1";

const script = (overrides = {}) => buildEnrollmentScript({
    publicKey: PUBLIC_KEY,
    callbackUrl: "https://nexterm.example/api/enroll/tok/callback",
    username: "root",
    createEntries: true,
    ...overrides,
});

/** A POSIX shell, when one is available; the script is only ever run on the target's sh. */
const findShell = () => {
    for (const candidate of ["/bin/sh", "/usr/bin/sh", "C:/Program Files/Git/usr/bin/sh.exe"]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
};
const shell = findShell();

describe("enrollment script", () => {
    it("carries the public key and the callback URL", () => {
        const text = script();
        assert.ok(text.includes(PUBLIC_KEY));
        assert.ok(text.includes("https://nexterm.example/api/enroll/tok/callback"));
    });

    it("never reports back when the token does not create entries", () => {
        assert.match(script({ createEntries: false }), /REPORT_BACK='no'/);
    });

    it("keeps an injected quote inside the assignment", () => {
        const text = script({ publicKey: `x'; rm -rf /; echo '` });
        const line = text.split("\n").find(l => l.startsWith("PUBLIC_KEY="));
        // Escaped as '\'' rather than closing the string and starting a command.
        assert.equal(line, `PUBLIC_KEY='x'\\''; rm -rf /; echo '\\'''`);
        assert.ok(!text.includes("\nrm -rf /"));
    });
});

describe("enrollment script behaviour", { skip: shell ? false : "no POSIX shell available" }, () => {
    /** Runs the script with HOME pointed at a throwaway directory and no reporting. */
    const run = (home) => execFileSync(shell, [path.join(home, "enroll.sh")], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

    const sandbox = (prepare) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexterm-enroll-"));
        fs.writeFileSync(path.join(dir, "enroll.sh"),
            script({ username: os.userInfo().username, createEntries: false }));
        prepare?.(dir);
        return dir;
    };

    const authorizedKeys = (dir) => fs.readFileSync(path.join(dir, ".ssh", "authorized_keys"), "utf8");

    it("installs the key when there is no authorized_keys yet", () => {
        const dir = sandbox();
        run(dir);
        assert.equal(authorizedKeys(dir).trim(), PUBLIC_KEY);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("does not install the key twice", () => {
        const dir = sandbox();
        run(dir);
        run(dir);
        assert.equal(authorizedKeys(dir).split("\n").filter(Boolean).length, 1);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("keeps existing keys and survives a missing trailing newline", () => {
        const dir = sandbox((root) => {
            fs.mkdirSync(path.join(root, ".ssh"));
            fs.writeFileSync(path.join(root, ".ssh", "authorized_keys"), "ssh-rsa AAAAOLD existing@host");
        });
        run(dir);

        const lines = authorizedKeys(dir).split("\n").filter(Boolean);
        assert.equal(lines.length, 2);
        assert.equal(lines[0], "ssh-rsa AAAAOLD existing@host");
        assert.equal(lines[1], PUBLIC_KEY);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("recognises its own key even when the comment changed", () => {
        const dir = sandbox((root) => {
            fs.mkdirSync(path.join(root, ".ssh"));
            const [type, body] = PUBLIC_KEY.split(" ");
            fs.writeFileSync(path.join(root, ".ssh", "authorized_keys"), `${type} ${body} renamed-by-hand\n`);
        });
        run(dir);
        assert.equal(authorizedKeys(dir).split("\n").filter(Boolean).length, 1);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
