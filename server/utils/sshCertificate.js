const crypto = require("crypto");
const { sshField } = require("./sshKeygen");

/**
 * An SSH user certificate authority, in the OpenSSH certificate format (PROTOCOL.certkeys).
 *
 * The CA key is ed25519: small, fast, and verified by every sshd since OpenSSH 6.5. Only the target's
 * sshd ever checks the CA signature; the client (libssh2 in the engine) just presents the certificate
 * alongside the user's own key, which stays RSA.
 */

const CERT_TYPE_USER = 1;

/** Extensions ssh-keygen grants by default, in the byte order the format requires. */
const DEFAULT_EXTENSIONS = [
    "permit-X11-forwarding",
    "permit-agent-forwarding",
    "permit-port-forwarding",
    "permit-pty",
    "permit-user-rc",
];

const uint32 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    return buffer;
};

const uint64 = (value) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(value), 0);
    return buffer;
};

/** Reads consecutive length-prefixed fields out of an SSH wire-format blob. */
const readFields = (blob) => {
    const fields = [];
    let offset = 0;
    while (offset + 4 <= blob.length) {
        const length = blob.readUInt32BE(offset);
        const end = offset + 4 + length;
        if (end > blob.length) throw new Error("Truncated SSH key blob");
        fields.push({ raw: blob.subarray(offset, end), value: blob.subarray(offset + 4, end) });
        offset = end;
    }
    if (offset !== blob.length) throw new Error("Malformed SSH key blob");
    return fields;
};

/** The wire blob of an ed25519 public key (`ssh-ed25519` + 32 raw bytes). */
const ed25519PublicBlob = (publicKey) => Buffer.concat([
    sshField(Buffer.from("ssh-ed25519")),
    sshField(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")),
]);

/**
 * Creates a CA key pair.
 *
 * @returns {{ privateKey: string, publicKey: string }} PKCS#8 PEM private key (store it encrypted) and
 *          the `ssh-ed25519 AAAA... comment` line sshd's TrustedUserCAKeys takes.
 */
module.exports.generateCaKeyPair = ({ comment = "nexterm-user-ca" } = {}) => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    return {
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: `ssh-ed25519 ${ed25519PublicBlob(publicKey).toString("base64")}${comment ? ` ${comment}` : ""}`,
    };
};

/**
 * Signs a user certificate for an RSA public key.
 *
 * @param {object} options
 * @param {string} options.caPrivateKey PEM of the ed25519 CA key
 * @param {string} options.userPublicKey the user's `ssh-rsa AAAA...` line
 * @param {string[]} options.principals user names the certificate is valid for
 * @param {string} options.keyId free-form id sshd logs on login (e.g. "nexterm identity 12")
 * @param {Date} options.validAfter
 * @param {Date} options.validBefore
 * @param {bigint|number} [options.serial]
 * @returns {string} `ssh-rsa-cert-v01@openssh.com AAAA... comment`
 */
module.exports.signUserCertificate = ({
    caPrivateKey, userPublicKey, principals, keyId, validAfter, validBefore, serial, comment = "",
}) => {
    const [type, body] = userPublicKey.trim().split(/\s+/);
    if (type !== "ssh-rsa" || !body) throw new Error("Only RSA user keys can be certified");

    const fields = readFields(Buffer.from(body, "base64"));
    if (fields.length !== 3 || fields[0].value.toString() !== "ssh-rsa") throw new Error("Not an RSA public key");
    const [, exponent, modulus] = fields;

    if (!principals?.length) throw new Error("A certificate needs at least one principal");

    const caKey = crypto.createPrivateKey(caPrivateKey);
    if (caKey.asymmetricKeyType !== "ed25519") throw new Error("The CA key must be ed25519");
    const caPublicBlob = ed25519PublicBlob(crypto.createPublicKey(caKey));

    const serialNumber = serial === undefined ? crypto.randomBytes(8).readBigUInt64BE(0) : BigInt(serial);

    const toBeSigned = Buffer.concat([
        sshField(Buffer.from("ssh-rsa-cert-v01@openssh.com")),
        sshField(crypto.randomBytes(32)),
        // e and n exactly as encoded in the public key, mpint padding included.
        exponent.raw,
        modulus.raw,
        uint64(serialNumber),
        uint32(CERT_TYPE_USER),
        sshField(Buffer.from(keyId || "")),
        sshField(Buffer.concat(principals.map(p => sshField(Buffer.from(p))))),
        uint64(Math.floor(validAfter.getTime() / 1000)),
        uint64(Math.floor(validBefore.getTime() / 1000)),
        sshField(Buffer.alloc(0)),
        sshField(Buffer.concat(DEFAULT_EXTENSIONS.map(name => Buffer.concat([
            sshField(Buffer.from(name)),
            sshField(Buffer.alloc(0)),
        ])))),
        sshField(Buffer.alloc(0)),
        sshField(caPublicBlob),
    ]);

    const signature = Buffer.concat([
        sshField(Buffer.from("ssh-ed25519")),
        sshField(crypto.sign(null, toBeSigned, caKey)),
    ]);

    const certificate = Buffer.concat([toBeSigned, sshField(signature)]);
    return `ssh-rsa-cert-v01@openssh.com ${certificate.toString("base64")}${comment ? ` ${comment}` : ""}`;
};
