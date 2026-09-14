const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { generateSshKeyPair, fingerprint } = require("./sshKeygen");

/** 2048 keeps the suite fast; the format is what matters here, not the modulus length. */
const keyPair = generateSshKeyPair({ comment: "nexterm-test", modulusLength: 2048 });

/** Reads the SSH wire format back into its fields. */
const parsePublicKey = (line) => {
    const blob = Buffer.from(line.split(" ")[1], "base64");
    const fields = [];
    let offset = 0;
    while (offset < blob.length) {
        const length = blob.readUInt32BE(offset);
        offset += 4;
        fields.push(blob.subarray(offset, offset + length));
        offset += length;
    }
    return fields;
};

const stripLeadingZeros = (buffer) => {
    let index = 0;
    while (index < buffer.length - 1 && buffer[index] === 0) index++;
    return buffer.subarray(index).toString("hex");
};

describe("generateSshKeyPair", () => {
    it("returns a PKCS#1 PEM private key, the format libssh2 accepts", () => {
        assert.ok(keyPair.privateKey.startsWith("-----BEGIN RSA PRIVATE KEY-----"));
        assert.doesNotThrow(() => crypto.createPrivateKey(keyPair.privateKey));
    });

    it("returns an authorized_keys line with the comment", () => {
        assert.match(keyPair.publicKey, /^ssh-rsa AAAA[A-Za-z0-9+/=]+ nexterm-test$/);
    });

    it("puts the key type first in the wire format", () => {
        assert.equal(parsePublicKey(keyPair.publicKey)[0].toString(), "ssh-rsa");
    });

    it("publishes the exponent and modulus of its own private key", () => {
        const publicKey = crypto.createPublicKey(crypto.createPrivateKey(keyPair.privateKey));
        const jwk = publicKey.export({ format: "jwk" });
        const [, exponent, modulus] = parsePublicKey(keyPair.publicKey);

        assert.equal(stripLeadingZeros(exponent), stripLeadingZeros(Buffer.from(jwk.e, "base64url")));
        assert.equal(stripLeadingZeros(modulus), stripLeadingZeros(Buffer.from(jwk.n, "base64url")));
    });

    it("keeps the modulus positive, which is what mpint padding is for", () => {
        const [, , modulus] = parsePublicKey(keyPair.publicKey);
        // A leading byte with the top bit set would read as negative, so it must be padded with 0x00.
        assert.ok(!(modulus[0] & 0x80) || modulus[0] === 0);
    });

    it("signs and verifies through the generated pair", () => {
        const privateKey = crypto.createPrivateKey(keyPair.privateKey);
        const signature = crypto.sign("sha256", Buffer.from("nexterm"), privateKey);
        assert.ok(crypto.verify("sha256", Buffer.from("nexterm"), crypto.createPublicKey(privateKey), signature));
    });

    it("produces a different key every time", () => {
        const other = generateSshKeyPair({ modulusLength: 2048 });
        assert.notEqual(other.publicKey, keyPair.publicKey);
    });
});

describe("fingerprint", () => {
    it("matches the fingerprint reported with the key", () => {
        assert.equal(fingerprint(keyPair.publicKey), keyPair.fingerprint);
    });

    it("is the SHA256 of the key blob, as OpenSSH prints it", () => {
        const blob = Buffer.from(keyPair.publicKey.split(" ")[1], "base64");
        const expected = crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
        assert.equal(keyPair.fingerprint, `SHA256:${expected}`);
    });

    it("ignores the comment", () => {
        const [type, body] = keyPair.publicKey.split(" ");
        assert.equal(fingerprint(`${type} ${body} someone@elsewhere`), keyPair.fingerprint);
    });
});
