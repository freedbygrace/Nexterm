/**
 * The shell script an enrollment token serves.
 *
 * It is piped straight into `sh` on the target, so it is deliberately small, POSIX-only and readable:
 * anyone about to run it should be able to audit it in one screen. It installs one public key into one
 * account's authorized_keys, idempotently, and reports the host back so Nexterm can create the entry.
 *
 * The only values interpolated are produced by us (a base64 key line, a URL and a token), and every one
 * is single-quote escaped, so a value can never break out into the script.
 */

/** Wraps a value in single quotes for POSIX sh, escaping any single quotes inside it. */
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/**
 * @param {object} options
 * @param {string} options.publicKey   the authorized_keys line to install
 * @param {string} options.callbackUrl absolute URL the host reports itself to
 * @param {string} options.username    account whose authorized_keys is written
 * @param {boolean} options.createEntries whether the callback is expected to create an entry
 */
module.exports.buildEnrollmentScript = ({ publicKey, callbackUrl, username, createEntries }) => `#!/bin/sh
# Nexterm host enrollment.
#
# Installs one SSH public key for ${username} and reports this host back to Nexterm.
# Running it again is safe: the key is only added when it is not already present.
set -eu

PUBLIC_KEY=${shellQuote(publicKey)}
CALLBACK_URL=${shellQuote(callbackUrl)}
TARGET_USER=${shellQuote(username)}
REPORT_BACK=${shellQuote(createEntries ? "yes" : "no")}

log() { printf '%s\\n' "nexterm: $1" >&2; }

# Home directory of the account the key is installed for.
if [ "$TARGET_USER" = "$(id -un)" ]; then
    HOME_DIR=$HOME
else
    HOME_DIR=$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)
    [ -n "\${HOME_DIR:-}" ] || { log "no such user: $TARGET_USER"; exit 1; }
    [ "$(id -u)" = "0" ] || { log "installing a key for $TARGET_USER needs root"; exit 1; }
fi

AUTHORIZED_KEYS=$HOME_DIR/.ssh/authorized_keys

mkdir -p "$HOME_DIR/.ssh"
chmod 700 "$HOME_DIR/.ssh"
[ -f "$AUTHORIZED_KEYS" ] || : > "$AUTHORIZED_KEYS"
chmod 600 "$AUTHORIZED_KEYS"

# Idempotent: compare against the key material itself, so a changed comment is not a second key.
KEY_BODY=$(printf '%s' "$PUBLIC_KEY" | awk '{print $2}')
if grep -qF "$KEY_BODY" "$AUTHORIZED_KEYS" 2>/dev/null; then
    log "key already installed"
else
    # Keep the file newline-terminated, otherwise the key joins the previous line.
    [ -s "$AUTHORIZED_KEYS" ] && [ "$(tail -c1 "$AUTHORIZED_KEYS" | wc -l)" -eq 0 ] && printf '\\n' >> "$AUTHORIZED_KEYS"
    printf '%s\\n' "$PUBLIC_KEY" >> "$AUTHORIZED_KEYS"
    log "key installed"
fi

if [ "$(id -un)" = "$TARGET_USER" ] || [ "$(id -u)" = "0" ]; then
    chown "$TARGET_USER" "$HOME_DIR/.ssh" "$AUTHORIZED_KEYS" 2>/dev/null || true
fi

[ "$REPORT_BACK" = "yes" ] || { log "done"; exit 0; }

# Report the host so Nexterm can create the connection. Nothing secret is sent.
HOSTNAME_VALUE=$(hostname 2>/dev/null || uname -n)
OS_VALUE=$( (. /etc/os-release 2>/dev/null && printf '%s' "\${PRETTY_NAME:-}") || true )
[ -n "\${OS_VALUE:-}" ] || OS_VALUE=$(uname -sr)
SSH_PORT=$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/ {print $2; exit}' /etc/ssh/sshd_config 2>/dev/null || true)
[ -n "\${SSH_PORT:-}" ] || SSH_PORT=22

# Address the target would be reached on; falls back to the first non-loopback address.
ADDRESS=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)
[ -n "\${ADDRESS:-}" ] || ADDRESS=$(hostname -I 2>/dev/null | awk '{print $1}' || true)

PAYLOAD=$(printf '{"hostname":"%s","address":"%s","os":"%s","port":%s,"username":"%s"}' \\
    "$HOSTNAME_VALUE" "\${ADDRESS:-}" "$OS_VALUE" "$SSH_PORT" "$TARGET_USER")

if command -v curl >/dev/null 2>&1; then
    RESPONSE=$(curl -fsS -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$CALLBACK_URL") || {
        log "could not report back to Nexterm; the key is installed"; exit 1; }
elif command -v wget >/dev/null 2>&1; then
    RESPONSE=$(wget -qO- --header='Content-Type: application/json' --post-data="$PAYLOAD" "$CALLBACK_URL") || {
        log "could not report back to Nexterm; the key is installed"; exit 1; }
else
    log "neither curl nor wget found; the key is installed but this host was not reported"
    exit 0
fi

log "enrolled: $RESPONSE"
`;
