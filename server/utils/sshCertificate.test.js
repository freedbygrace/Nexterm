const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { generateCaKeyPair, signUserCertificate } = require("./sshCertificate");
const { generateSshKeyPair, publicKeyFromPrivate } = require("./sshKeygen");

/** Splits an SSH wire blob into its length-prefixed fields, leaving fixed-size integers to the caller. */
const reader = (blob) => {
    let offset = 0;
    return {
        string() {
            const length = blob.readUInt32BE(offset);
            const value = blob.subarray(offset + 4, offset + 4 + length);
            offset += 4 + length;
            return value;
        },
        uint32() { const v = blob.readUInt32BE(offset); offset += 4; return v; },
        uint64() { const v = blob.readBigUInt64BE(offset); offset += 8; return v; },
        get offset() { return offset; },
        get done() { return offset === blob.length; },
    };
};

const listOf = (buffer) => {
    const r = reader(buffer);
    const items = [];
    while (!r.done) items.push(r.string().toString());
    return items;
};

const ca = generateCaKeyPair({ comment: "test-ca" });
const user = generateSshKeyPair({ comment: "user", modulusLength: 2048 });

const sign = (overrides = {}) => signUserCertificate({
    caPrivateKey: ca.privateKey,
    userPublicKey: user.publicKey,
    principals: ["deploy"],
    keyId: "nexterm identity 7",
    validAfter: new Date("2026-01-01T00:00:00Z"),
    validBefore: new Date("2026-01-01T00:10:00Z"),
    serial: 42,
    ...overrides,
});

describe("generateCaKeyPair", () => {
    it("returns an ed25519 key and the line TrustedUserCAKeys takes", () => {
        assert.match(ca.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+=* test-ca$/);
        assert.equal(crypto.createPrivateKey(ca.privateKey).asymmetricKeyType, "ed25519");
    });
});

describe("signUserCertificate", () => {
    it("lays the certificate out as PROTOCOL.certkeys describes", () => {
        const [type, body] = sign().split(" ");
        assert.equal(type, "ssh-rsa-cert-v01@openssh.com");

        const blob = Buffer.from(body, "base64");
        const r = reader(blob);
        assert.equal(r.string().toString(), "ssh-rsa-cert-v01@openssh.com");
        assert.equal(r.string().length, 32, "nonce");

        // e and n are the user's own, byte for byte.
        const userBlob = reader(Buffer.from(user.publicKey.split(" ")[1], "base64"));
        userBlob.string();
        assert.deepEqual(r.string(), userBlob.string(), "exponent");
        assert.deepEqual(r.string(), userBlob.string(), "modulus");

        assert.equal(r.uint64(), 42n, "serial");
        assert.equal(r.uint32(), 1, "user certificate");
        assert.equal(r.string().toString(), "nexterm identity 7");
        assert.deepEqual(listOf(r.string()), ["deploy"]);
        assert.equal(r.uint64(), BigInt(Date.parse("2026-01-01T00:00:00Z") / 1000));
        assert.equal(r.uint64(), BigInt(Date.parse("2026-01-01T00:10:00Z") / 1000));
        assert.equal(r.string().length, 0, "no critical options");

        const extensions = listOf(r.string()).filter((_, i) => i % 2 === 0);
        assert.deepEqual(extensions, [...extensions].sort(), "extensions in byte order");
        assert.ok(extensions.includes("permit-pty"));

        assert.equal(r.string().length, 0, "reserved");
        const signatureKey = r.string();
        const signedLength = r.offset;
        const signature = reader(r.string());
        assert.ok(r.done);

        assert.equal(signature.string().toString(), "ssh-ed25519");
        const caKey = crypto.createPublicKey(crypto.createPrivateKey(ca.privateKey));
        assert.ok(crypto.verify(null, blob.subarray(0, signedLength), caKey, signature.string()), "CA signature");
        assert.deepEqual(signatureKey, Buffer.from(ca.publicKey.split(" ")[1], "base64"), "signed by this CA");
    });

    it("gives every certificate a fresh nonce", () => {
        assert.notEqual(sign(), sign());
    });

    it("refuses what it cannot certify", () => {
        assert.throws(() => sign({ principals: [] }), /principal/);
        assert.throws(() => sign({ userPublicKey: ca.publicKey }), /RSA/);
        assert.throws(() => sign({ caPrivateKey: user.privateKey }), /ed25519/);
    });
});

describe("publicKeyFromPrivate", () => {
    it("derives the same line the key pair was generated with", () => {
        assert.equal(publicKeyFromPrivate(user.privateKey), user.publicKey.replace(/ user$/, ""));
    });

    it("returns null for keys it cannot use", () => {
        assert.equal(publicKeyFromPrivate(ca.privateKey), null);
        assert.equal(publicKeyFromPrivate("not a key"), null);
    });
});
