/**
 * The scripts an enrollment token serves: POSIX sh for Linux, macOS and the BSDs, PowerShell for
 * Windows (OpenSSH for Windows).
 *
 * They are piped straight into a shell on the target, so they are deliberately small and readable:
 * anyone about to run one should be able to audit it in a few screens. Depending on the token's method
 * a script either installs one public key into one account's authorized_keys, or makes sshd trust
 * Nexterm's SSH certificate authority; both are idempotent. Then it reports the host back so Nexterm
 * can create the entry.
 *
 * The only values interpolated are produced by us (a base64 key line, a URL, a token and the target
 * user name), and every one is quoted for its shell, so a value can never break out into the script.
 */

/** Wraps a value in single quotes for POSIX sh, escaping any single quotes inside it. */
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/** Wraps a value in single quotes for PowerShell, where a quote is escaped by doubling it. */
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

// ---------------------------------------------------------------------------------------------- sh

const SH_INSTALL_KEY = `
# Home directory of the account the key is installed for.
if [ "$TARGET_USER" = "$(id -un)" ]; then
    HOME_DIR=$HOME
else
    HOME_DIR=$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)
    # macOS has no getent; its directory service knows the home instead.
    [ -n "\${HOME_DIR:-}" ] || HOME_DIR=$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)
    [ -n "\${HOME_DIR:-}" ] || { log "no such user: $TARGET_USER"; exit 1; }
    [ "$(id -u)" = "0" ] || { log "installing a key for $TARGET_USER needs root (pipe this into 'sudo sh')"; exit 1; }
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
    append_line "$AUTHORIZED_KEYS" "$PUBLIC_KEY"
    log "key installed"
fi

if [ "$(id -un)" = "$TARGET_USER" ] || [ "$(id -u)" = "0" ]; then
    chown "$TARGET_USER" "$HOME_DIR/.ssh" "$AUTHORIZED_KEYS" 2>/dev/null || true
fi
`;

const SH_TRUST_CA = `
[ "$(id -u)" = "0" ] || { log "trusting a certificate authority changes sshd's configuration and needs root (pipe this into 'sudo sh')"; exit 1; }

# NEXTERM_SSH_DIR only exists so the script can be tested against a scratch copy of /etc/ssh.
SSH_DIR=\${NEXTERM_SSH_DIR:-/etc/ssh}
SSHD_CONFIG=$SSH_DIR/sshd_config
[ -f "$SSHD_CONFIG" ] || { log "no $SSHD_CONFIG - is the OpenSSH server installed?"; exit 1; }
SSHD=$(command -v sshd 2>/dev/null || true)
for candidate in /usr/sbin/sshd /usr/local/sbin/sshd /usr/bin/sshd; do
    [ -n "$SSHD" ] || { [ -x "$candidate" ] && SSHD=$candidate; }
done

# sshd honours only the first TrustedUserCAKeys it reads, so an existing CA file is extended rather
# than replaced; only when there is none does Nexterm add one of its own.
CA_FILE=
if [ -n "$SSHD" ]; then
    CA_FILE=$("$SSHD" -T -f "$SSHD_CONFIG" 2>/dev/null | awk 'tolower($1) == "trustedusercakeys" {print $2; exit}' || true)
fi
if [ -z "$CA_FILE" ]; then
    CA_FILE=$(awk 'tolower($1) == "trustedusercakeys" {print $2; exit}' "$SSHD_CONFIG" "$SSH_DIR"/sshd_config.d/*.conf 2>/dev/null || true)
fi
[ "$CA_FILE" = "none" ] && CA_FILE=

CONFIG_CHANGED=no
DROP_IN=
if [ -z "$CA_FILE" ]; then
    CA_FILE=$SSH_DIR/nexterm_user_ca.pub
    cp "$SSHD_CONFIG" "$SSHD_CONFIG.nexterm.bak"
    if grep -qiE '^[[:space:]]*Include[[:space:]].*sshd_config\\.d' "$SSHD_CONFIG" && [ -d "$SSH_DIR/sshd_config.d" ]; then
        # Debian, Ubuntu, Fedora: a drop-in, read before the main file's own settings.
        DROP_IN=$SSH_DIR/sshd_config.d/50-nexterm-user-ca.conf
        printf '# Added by Nexterm host enrollment.\\nTrustedUserCAKeys %s\\n' "$CA_FILE" > "$DROP_IN"
        chmod 644 "$DROP_IN"
    else
        # Otherwise before the first Match block, where it still applies to every connection.
        awk -v line="TrustedUserCAKeys $CA_FILE" '
            !done && tolower($1) == "match" { print "# Added by Nexterm host enrollment."; print line; done = 1 }
            { print }
            END { if (!done) { print "# Added by Nexterm host enrollment."; print line } }
        ' "$SSHD_CONFIG.nexterm.bak" > "$SSHD_CONFIG"
    fi
    CONFIG_CHANGED=yes
fi

# The file may list several CAs; add Nexterm's once.
CA_BODY=$(printf '%s' "$CA_KEY" | awk '{print $2}')
if [ -f "$CA_FILE" ] && grep -qF "$CA_BODY" "$CA_FILE"; then
    log "certificate authority already trusted ($CA_FILE)"
else
    append_line "$CA_FILE" "$CA_KEY"
    chmod 644 "$CA_FILE"
    log "certificate authority added to $CA_FILE"
fi

if [ "$CONFIG_CHANGED" = "yes" ]; then
    if [ -n "$SSHD" ] && ! "$SSHD" -t -f "$SSHD_CONFIG"; then
        log "sshd rejected the new configuration; restoring it"
        [ -n "$DROP_IN" ] && rm -f "$DROP_IN"
        cp "$SSHD_CONFIG.nexterm.bak" "$SSHD_CONFIG"
        exit 1
    fi
    if [ -z "\${NEXTERM_SSH_DIR:-}" ]; then
        # Whichever service manager this host has; macOS starts sshd per connection and needs none.
        { systemctl reload ssh || systemctl reload sshd || service ssh reload || service sshd reload \\
            || rc-service sshd reload || { [ -f /var/run/sshd.pid ] && kill -HUP "$(cat /var/run/sshd.pid)"; } \\
            || [ "$(uname -s)" = "Darwin" ]; } >/dev/null 2>&1 \\
            || log "could not reload sshd - restart it to trust the certificate authority"
    fi
    log "sshd now trusts certificates from $CA_FILE"
fi
`;

const SH_REPORT = `
[ "$REPORT_BACK" = "yes" ] || { log "done"; exit 0; }

# Report the host so Nexterm can create the connection. Nothing secret is sent.
HOSTNAME_VALUE=$(hostname 2>/dev/null || uname -n)
OS_VALUE=$( (. /etc/os-release 2>/dev/null && printf '%s' "\${PRETTY_NAME:-}") || true )
[ -n "\${OS_VALUE:-}" ] || OS_VALUE=$( (sw_vers -productName 2>/dev/null && sw_vers -productVersion 2>/dev/null) | tr '\\n' ' ' || true )
[ -n "\${OS_VALUE:-}" ] || OS_VALUE=$(uname -sr)
SSH_PORT=$(awk 'tolower($1) == "port" && $2 ~ /^[0-9]+$/ {print $2; exit}' /etc/ssh/sshd_config 2>/dev/null || true)
[ -n "\${SSH_PORT:-}" ] || SSH_PORT=22

# Address the target would be reached on; falls back to the first non-loopback address.
ADDRESS=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)
[ -n "\${ADDRESS:-}" ] || ADDRESS=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
[ -n "\${ADDRESS:-}" ] || ADDRESS=$(ifconfig 2>/dev/null | awk '$1 == "inet" && $2 !~ /^127\\./ {print $2; exit}' || true)

# JSON-escape what the host reports about itself.
json() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr -d '\\000-\\037'; }
PAYLOAD=$(printf '{"hostname":"%s","address":"%s","os":"%s","port":%s,"username":"%s"}' \\
    "$(json "$HOSTNAME_VALUE")" "$(json "\${ADDRESS:-}")" "$(json "$OS_VALUE")" "$SSH_PORT" "$(json "$TARGET_USER")")

if command -v curl >/dev/null 2>&1; then
    RESPONSE=$(curl -fsS -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$CALLBACK_URL") || {
        log "could not report back to Nexterm; $DONE_WHAT"; exit 1; }
elif command -v wget >/dev/null 2>&1; then
    RESPONSE=$(wget -qO- --header='Content-Type: application/json' --post-data="$PAYLOAD" "$CALLBACK_URL") || {
        log "could not report back to Nexterm; $DONE_WHAT"; exit 1; }
else
    log "neither curl nor wget found; $DONE_WHAT but this host was not reported"
    exit 0
fi

log "enrolled: $RESPONSE"
`;

/**
 * @param {object} options
 * @param {"key"|"certificate"} [options.method] install a key, or trust the certificate authority
 * @param {string} [options.publicKey]  the authorized_keys line to install (method "key")
 * @param {string} [options.caPublicKey] the CA line sshd should trust (method "certificate")
 * @param {string} options.callbackUrl absolute URL the host reports itself to
 * @param {string} options.username    account the key is for / the certificates are issued to
 * @param {boolean} options.createEntries whether the callback is expected to create an entry
 */
module.exports.buildEnrollmentScript = ({ method = "key", publicKey, caPublicKey, callbackUrl, username, createEntries }) => {
    const certificate = method === "certificate";
    return `#!/bin/sh
# Nexterm host enrollment.
#
${certificate
        ? `# Makes sshd trust Nexterm's SSH certificate authority, so ${username} can log in with the short-lived
# certificates Nexterm signs, and reports this host back to Nexterm. Needs root.`
        : `# Installs one SSH public key for ${username} and reports this host back to Nexterm.`}
# Running it again is safe: nothing is added twice.
set -eu

${certificate ? `CA_KEY=${shellQuote(caPublicKey)}` : `PUBLIC_KEY=${shellQuote(publicKey)}`}
CALLBACK_URL=${shellQuote(callbackUrl)}
TARGET_USER=${shellQuote(username)}
REPORT_BACK=${shellQuote(createEntries ? "yes" : "no")}
DONE_WHAT=${shellQuote(certificate ? "the certificate authority is trusted" : "the key is installed")}

log() { printf '%s\\n' "nexterm: $1" >&2; }

# Appends a line, keeping the file newline-terminated so it never joins the previous one.
append_line() {
    if [ -s "$1" ] && [ "$(tail -c1 "$1" | wc -l)" -eq 0 ]; then printf '\\n' >> "$1"; fi
    printf '%s\\n' "$2" >> "$1"
}
${certificate ? SH_TRUST_CA : SH_INSTALL_KEY}${SH_REPORT}`;
};

// -------------------------------------------------------------------------------------- PowerShell

const PS_INSTALL_KEY = `
        # Administrators read their keys from one shared file when sshd_config says so (the Windows default).
        $sid = (New-Object System.Security.Principal.NTAccount($TargetUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
        $isAdmin = [bool](Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $sid })
        $usesAdminFile = $isAdmin -and (Select-String -Path $SshdConfig -Pattern '^\\s*AuthorizedKeysFile\\s+.*administrators_authorized_keys' -Quiet)

        if ($usesAdminFile) {
            $keysFile = Join-Path $SshDir 'administrators_authorized_keys'
        } else {
            $profilePath = if ($TargetUser -eq $env:USERNAME) { $env:USERPROFILE } else {
                (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath
            }
            if (-not $profilePath) { throw "$TargetUser has no profile yet - log in as $TargetUser once, then run this again" }
            $userSshDir = Join-Path $profilePath '.ssh'
            New-Item -ItemType Directory -Force -Path $userSshDir | Out-Null
            $keysFile = Join-Path $userSshDir 'authorized_keys'
        }

        $keyBody = ($PublicKey -split '\\s+')[1]
        if ((Test-Path $keysFile) -and (Select-String -Path $keysFile -SimpleMatch $keyBody -Quiet)) {
            Log 'key already installed'
        } else {
            Add-Line $keysFile $PublicKey
            Log "key installed in $keysFile"
        }

        # sshd refuses key files that anyone else can write to.
        if ($usesAdminFile) {
            icacls $keysFile /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
        } else {
            icacls $keysFile /inheritance:r /grant "*\${sid}:F" /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F' | Out-Null
        }
`;

const PS_TRUST_CA = `
        # sshd honours only the first TrustedUserCAKeys it reads, so an existing CA file is extended
        # rather than replaced; only when there is none does Nexterm add one of its own.
        $caFile = $null
        if ($Sshd) {
            $effective = Invoke-Native { & $Sshd -T -f $SshdConfig } | Where-Object { $_ -match '^trustedusercakeys\\s' } | Select-Object -First 1
            if ($effective -match '^trustedusercakeys\\s+(.+)' -and $Matches[1].Trim() -ne 'none') {
                $caFile = $Matches[1].Trim() -replace '__PROGRAMDATA__', $env:ProgramData
            }
        }
        if (-not $caFile) {
            # sshd -T needs the host keys; read the file itself when it could not run.
            $line = Select-String -Path $SshdConfig -Pattern '^\\s*TrustedUserCAKeys\\s+(\\S+)' | Select-Object -First 1
            if ($line -and $line.Matches[0].Groups[1].Value -ne 'none') {
                $caFile = $line.Matches[0].Groups[1].Value -replace '__PROGRAMDATA__', $env:ProgramData
            }
        }

        $configChanged = $false
        $backup = "$SshdConfig.nexterm.bak"
        if (-not $caFile) {
            $caFile = Join-Path $SshDir 'nexterm_user_ca.pub'
            Copy-Item $SshdConfig $backup -Force
            # Before the first Match block (Windows ships one at the end), where it applies to every connection.
            $lines = [System.Collections.Generic.List[string]](Get-Content $SshdConfig)
            $at = $lines.FindIndex([Predicate[string]] { param($l) $l -match '^\\s*Match\\s' })
            if ($at -lt 0) { $at = $lines.Count }
            $lines.InsertRange($at, [string[]]@('# Added by Nexterm host enrollment.', "TrustedUserCAKeys $($caFile -replace '\\\\', '/')"))
            [System.IO.File]::WriteAllLines($SshdConfig, $lines, $Utf8)
            $configChanged = $true
        }

        $caBody = ($CaKey -split '\\s+')[1]
        if ((Test-Path $caFile) -and (Select-String -Path $caFile -SimpleMatch $caBody -Quiet)) {
            Log "certificate authority already trusted ($caFile)"
        } else {
            Add-Line $caFile $CaKey
            Log "certificate authority added to $caFile"
        }

        if ($configChanged) {
            if ($Sshd) {
                $problems = Invoke-Native { & $Sshd -t -f $SshdConfig }
                if ($LASTEXITCODE -ne 0) {
                    Copy-Item $backup $SshdConfig -Force
                    throw "sshd rejected the new configuration, which has been restored: $problems"
                }
            }
            if (-not $env:NEXTERM_SSH_DIR) { Restart-Service sshd }
            Log "sshd now trusts certificates from $caFile"
        }
`;

/**
 * The PowerShell counterpart of buildEnrollmentScript, for OpenSSH on Windows. Run from an elevated
 * PowerShell as `irm <url> | iex`; everything runs inside a script block, so an error never closes
 * the caller's window.
 */
module.exports.buildEnrollmentPowerShell = ({ method = "key", publicKey, caPublicKey, callbackUrl, username, createEntries }) => {
    const certificate = method === "certificate";
    return `# Nexterm host enrollment (Windows).
#
${certificate
        ? `# Makes the OpenSSH server trust Nexterm's SSH certificate authority, so ${username} can log in with
# the short-lived certificates Nexterm signs, and reports this host back to Nexterm.`
        : `# Installs one SSH public key for ${username} and reports this host back to Nexterm.`}
# Run from an elevated PowerShell. Running it again is safe: nothing is added twice.
& {
    $ErrorActionPreference = 'Stop'
    ${certificate ? `$CaKey = ${psQuote(caPublicKey)}` : `$PublicKey = ${psQuote(publicKey)}`}
    $CallbackUrl = ${psQuote(callbackUrl)}
    $TargetUser = ${psQuote(username)}
    $ReportBack = ${createEntries ? "$true" : "$false"}

    function Log($message) { Write-Host "nexterm: $message" }
    # Windows PowerShell turns a native command's stderr into terminating errors under 'Stop'.
    function Invoke-Native([scriptblock] $command) {
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & $command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $saved }
    }
    $Utf8 = New-Object System.Text.UTF8Encoding($false)
    # Appends a line without a byte-order mark, which sshd would read as part of the first key.
    function Add-Line($path, $line) {
        $prefix = ''
        if ((Test-Path $path) -and (Get-Item $path).Length -gt 0) {
            if ([System.IO.File]::ReadAllBytes($path)[-1] -ne 10) { $prefix = "\`n" }
        }
        [System.IO.File]::AppendAllText($path, "$prefix$line\`n", $Utf8)
    }

    try {
        # NEXTERM_SSH_DIR only exists so the script can be tested against a scratch copy.
        $SshDir = if ($env:NEXTERM_SSH_DIR) { $env:NEXTERM_SSH_DIR } else { Join-Path $env:ProgramData 'ssh' }
        $SshdConfig = Join-Path $SshDir 'sshd_config'
        if (-not $env:NEXTERM_SSH_DIR -and -not (Get-Service sshd -ErrorAction SilentlyContinue)) {
            throw 'the OpenSSH server is not installed - Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0, then Start-Service sshd'
        }
        if (-not (Test-Path $SshdConfig)) { throw "no $SshdConfig - start the sshd service once so it writes its default configuration" }
        $Sshd = (Get-Command sshd -ErrorAction SilentlyContinue).Source
        if (-not $Sshd -and (Test-Path "$env:SystemRoot\\System32\\OpenSSH\\sshd.exe")) { $Sshd = "$env:SystemRoot\\System32\\OpenSSH\\sshd.exe" }

        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $elevated -and -not $env:NEXTERM_SSH_DIR -and ${certificate ? "$true" : "$TargetUser -ne $env:USERNAME"}) {
            throw 'run this from an elevated PowerShell (Run as administrator)'
        }
${certificate ? PS_TRUST_CA : PS_INSTALL_KEY}
        if (-not $ReportBack) { Log 'done'; return }

        # Report the host so Nexterm can create the connection. Nothing secret is sent.
        $port = 22
        $portLine = Select-String -Path $SshdConfig -Pattern '^\\s*Port\\s+(\\d+)' | Select-Object -First 1
        if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }
        $address = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric |
            Select-Object -First 1 | Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
        if (-not $address) {
            $address = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\\.254)\\.' } | Select-Object -First 1).IPAddress
        }
        $report = @{
            hostname = $env:COMPUTERNAME
            address = "$address"
            os = (Get-CimInstance Win32_OperatingSystem).Caption
            port = $port
            username = $TargetUser
        } | ConvertTo-Json -Compress

        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $response = Invoke-RestMethod -Method Post -Uri $CallbackUrl -ContentType 'application/json' -Body $report
        Log "enrolled: $($response.message)"
    } catch {
        Write-Host "nexterm: $($_.Exception.Message)" -ForegroundColor Red
    }
}
`;
};

/** What a failing token serves to PowerShell: an error, without closing the caller's window. */
module.exports.buildPowerShellError = (message) =>
    `Write-Host ${psQuote(`nexterm: ${message}`)} -ForegroundColor Red\n`;
