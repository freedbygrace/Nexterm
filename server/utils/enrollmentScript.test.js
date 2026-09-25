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

describe("certificate enrollment script", () => {
    const { buildEnrollmentScript: build } = require("./enrollmentScript");
    const CA_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest nexterm-user-ca";
    const text = build({ method: "certificate", caPublicKey: CA_KEY, callbackUrl: "https://n.example/cb", username: "deploy", createEntries: true });

    it("carries the CA and no user key", () => {
        assert.ok(text.includes(`CA_KEY='${CA_KEY}'`));
        assert.ok(!text.includes("PUBLIC_KEY="));
        assert.ok(!text.includes("authorized_keys"));
    });

    it("extends an existing TrustedUserCAKeys instead of shadowing it", () => {
        // sshd uses the first occurrence only; a second directive would silently be ignored.
        assert.match(text, /-T -f "\$SSHD_CONFIG"/);
        assert.match(text, /tolower\(\$1\) == "trustedusercakeys"/);
    });

    it("validates sshd's configuration and restores it on failure", () => {
        assert.match(text, /-t -f "\$SSHD_CONFIG"/);
        assert.match(text, /cp "\$SSHD_CONFIG\.nexterm\.bak" "\$SSHD_CONFIG"/);
    });

    it("is valid sh", { skip: shell ? false : "no POSIX shell available" }, () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexterm-ca-")), "ca.sh");
        fs.writeFileSync(file, text);
        execFileSync(shell, ["-n", file]);
    });
});

describe("Windows enrollment script", () => {
    const { buildEnrollmentPowerShell, buildPowerShellError } = require("./enrollmentScript");
    const ps = (overrides = {}) => buildEnrollmentPowerShell({
        publicKey: PUBLIC_KEY, callbackUrl: "https://n.example/cb", username: "Administrator", createEntries: true, ...overrides,
    });

    it("runs in a script block and never exits the caller's shell", () => {
        const text = ps();
        assert.ok(text.includes("& {"));
        assert.ok(!/^\s*exit\b/m.test(text));
    });

    it("keeps an injected quote inside the string", () => {
        const text = ps({ username: "x'; Remove-Item C:\ -Recurse; '" });
        const line = text.split("\n").find(l => l.trim().startsWith("$TargetUser ="));
        assert.equal(line.trim(), `$TargetUser = 'x''; Remove-Item C:\ -Recurse; '''`);
    });

    it("installs a key or trusts the CA depending on the method", () => {
        assert.match(ps(), /administrators_authorized_keys/);
        const ca = ps({ method: "certificate", publicKey: undefined, caPublicKey: "ssh-ed25519 AAAAC3 ca" });
        assert.match(ca, /TrustedUserCAKeys/);
        assert.ok(!ca.includes("administrators_authorized_keys"));
    });

    it("writes files without a byte-order mark", () => {
        assert.match(ps(), /UTF8Encoding\(\$false\)/);
    });

    it("reports a failing token without closing the window", () => {
        assert.equal(buildPowerShellError("it's revoked"), "Write-Host 'nexterm: it''s revoked' -ForegroundColor Red\n");
    });
});
