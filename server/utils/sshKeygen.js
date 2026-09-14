const crypto = require("crypto");

/**
 * SSH key generation for enrollment.
 *
 * Keys are RSA in PKCS#1 PEM, the one private-key format every SSH implementation and libssh2 build
 * accepts (ed25519 would need the OpenSSH container format and a libssh2 built with ed25519 support).
 * The public key is assembled in the OpenSSH wire format so it can be written straight into
 * `authorized_keys`.
 */

const DEFAULT_MODULUS_LENGTH = 4096;

/** Length-prefixed field as used by the SSH wire format (RFC 4251 "string"). */
const sshField = (buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(buffer.length, 0);
    return Buffer.concat([length, buffer]);
};

/**
 * An SSH "mpint" is two's-complement big-endian with no leading zero bytes, so a value whose top bit
 * is set has to be padded with 0x00 to keep it positive.
 */
const sshMpint = (buffer) => {
    let start = 0;
    while (start < buffer.length - 1 && buffer[start] === 0) start++;
    const trimmed = buffer.subarray(start);
    return sshField(trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
};

/** Builds the `ssh-rsa AAAA... comment` line for an RSA public key. */
const toOpenSshPublicKey = (publicKey, comment) => {
    const jwk = publicKey.export({ format: "jwk" });
    const exponent = Buffer.from(jwk.e, "base64url");
    const modulus = Buffer.from(jwk.n, "base64url");

    const blob = Buffer.concat([
        sshField(Buffer.from("ssh-rsa")),
        sshMpint(exponent),
        sshMpint(modulus),
    ]);

    return `ssh-rsa ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;
};

/**
 * Generates an SSH key pair.
 *
 * @param {object} [options]
 * @param {string} [options.comment] comment appended to the public key, e.g. "nexterm-enrollment-3"
 * @param {number} [options.modulusLength] RSA modulus length; 4096 unless a caller needs otherwise
 * @returns {{ privateKey: string, publicKey: string, fingerprint: string }} PEM private key, the
 *          `authorized_keys` line, and the SHA256 fingerprint OpenSSH prints.
 */
module.exports.generateSshKeyPair = ({ comment = "", modulusLength = DEFAULT_MODULUS_LENGTH } = {}) => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength });

    const openSshPublicKey = toOpenSshPublicKey(publicKey, comment);

    return {
        privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
        publicKey: openSshPublicKey,
        fingerprint: module.exports.fingerprint(openSshPublicKey),
    };
};

/** SHA256 fingerprint of an `authorized_keys` line, in the form OpenSSH prints. */
module.exports.fingerprint = (publicKeyLine) => {
    const blob = Buffer.from(publicKeyLine.trim().split(/\s+/)[1] || "", "base64");
    const digest = crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    return `SHA256:${digest}`;
};
