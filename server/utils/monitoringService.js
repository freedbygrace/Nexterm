const logger = require("./logger");
const { isProtocolEnabled } = require("./entryProtocols");
const Entry = require("../models/Entry");
const EntryIdentity = require("../models/EntryIdentity");
const MonitoringData = require("../models/MonitoringData");
const MonitoringSnapshot = require("../models/MonitoringSnapshot");
const Identity = require("../models/Identity");
const { Op } = require("sequelize");
const { getIdentityCredentials } = require("../controllers/identity");
const { getMonitoringSettingsInternal } = require("../controllers/monitoring");
const controlPlane = require("../lib/controlPlane/ControlPlaneServer");
const { buildSSHParams, resolveJumpHosts } = require("../lib/ConnectionService");

let monitoringInterval = null;
let isRunning = false;
let currentSettings = null;

const start = async () => {
    if (isRunning) return;
    isRunning = true;

    currentSettings = await getMonitoringSettingsInternal();
    const interval = currentSettings?.monitoringInterval ? currentSettings.monitoringInterval * 1000 : 60000;

    logger.system("Starting monitoring service", { interval });

    runMonitoring();
    monitoringInterval = setInterval(runMonitoring, interval);
};

const stop = () => {
    if (monitoringInterval) clearInterval(monitoringInterval);
    monitoringInterval = null;
    isRunning = false;
};

const runMonitoring = async () => {
    try {
        currentSettings = await getMonitoringSettingsInternal();

        if (!currentSettings?.monitoringEnabled) {
            logger.verbose("Monitoring is disabled, skipping cycle");
            return;
        }

        const entries = await Entry.findAll({ where: { type: "server" } });
        const toMonitor = entries.filter(e => isProtocolEnabled(e, "ssh") && e.config?.monitoringEnabled);
        if (toMonitor.length) await Promise.allSettled(toMonitor.map(monitorEntry));
    } catch (error) {
        logger.error("Error running monitoring", { error: error.message });
    }
};

const monitorEntry = async (entry) => {
    try {
        const entryIdentities = await EntryIdentity.findAll({ where: { entryId: entry.id }, order: [["isDefault", "DESC"]] });
        if (!entryIdentities?.length) return saveMonitoringData(entry.id, { status: "error", errorMessage: "No identities configured" });

        const identities = await Identity.findAll({ where: { id: entryIdentities.map(ei => ei.identityId) } });
        if (!identities?.length) return saveMonitoringData(entry.id, { status: "error", errorMessage: "No valid identities found" });

        const credentials = await getIdentityCredentials(identities[0].id);
        const data = await collectServerData(entry, identities[0], credentials);
        await saveMonitoringData(entry.id, data);
    } catch (error) {
        logger.error("Error monitoring entry", { entryId: entry.id, error: error.message });
        await saveMonitoringData(entry.id, { status: "error", errorMessage: error.message });
    }
};

const IFACE_DETAIL_CMD =
    'for d in /sys/class/net/*; do n=$(basename "$d"); ' +
    'printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$n" ' +
    '"$(cat "$d/address" 2>/dev/null)" ' +
    '"$(cat "$d/operstate" 2>/dev/null)" ' +
    '"$(cat "$d/mtu" 2>/dev/null)" ' +
    '"$(cat "$d/speed" 2>/dev/null)" ' +
    '"$(cat "$d/statistics/rx_bytes" 2>/dev/null)" ' +
    '"$(cat "$d/statistics/tx_bytes" 2>/dev/null)"; done';

const COMMANDS = {
    cpu: "grep 'cpu ' /proc/stat",
    memory: "free -b",
    uptime: "cat /proc/uptime",
    loadAverage: "cat /proc/loadavg",
    processCount: "ps -e --no-headers | wc -l",
    processList: "ps aux --sort=-%cpu | head -51",
    lsblk: "lsblk -b -o NAME,TYPE,SIZE,MODEL,SERIAL,ROTA,MOUNTPOINT -J",
    df: "df -B1 --output=source,fstype,size,used,avail,pcent,target | grep -E '^/dev'",
    osRelease: "cat /etc/os-release",
    kernel: "uname -r",
    arch: "uname -m",
    hostname: "hostname",
    ipAddr: "ip -o addr show",
    ifaceDetails: IFACE_DETAIL_CMD,
};

// Windows hosts are polled with PowerShell over SSH. Scripts are passed via -EncodedCommand so they
// work regardless of whether the remote default shell is cmd.exe or PowerShell (no quoting issues).
const powershell = (script) =>
    `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;

const WINDOWS_PROBE_ID = "windowsProbe";
const WINDOWS_PROBE_CMD = powershell("[System.Environment]::OSVersion.Platform");

const WINDOWS_COMMANDS = {
    cpu: powershell("Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average"),
    memory: powershell(
        "$os = Get-CimInstance Win32_OperatingSystem; " +
        "Write-Output ($os.TotalVisibleMemorySize * 1KB); Write-Output ($os.FreePhysicalMemory * 1KB)",
    ),
    uptime: powershell("[int](((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds)"),
    processCount: powershell("(Get-Process).Count"),
    processList: powershell(
        "$total = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize * 1KB; " +
        "try { $procs = Get-Process -IncludeUserName -ErrorAction Stop } catch { $procs = Get-Process }; " +
        "$procs | Sort-Object CPU -Descending | Select-Object -First 50 | ForEach-Object { " +
        "Write-Output ($_.UserName + '|' + $_.Id + '|' + [math]::Round([double]$_.CPU, 1) + '|' + " +
        "[math]::Round($_.WorkingSet64 / $total * 100, 1) + '|' + [math]::Round($_.VirtualMemorySize64 / 1KB) + '|' + " +
        "[math]::Round($_.WorkingSet64 / 1KB) + '|' + $_.ProcessName) }",
    ),
    disk: powershell(
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { " +
        "Write-Output ($_.DeviceID + '|' + $_.Size + '|' + $_.FreeSpace + '|' + $_.FileSystem + '|' + $_.VolumeName) }",
    ),
    osInfo: powershell(
        "$os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem; " +
        "Write-Output ($os.Caption + '|' + $os.Version + '|' + $os.BuildNumber + '|' + $cs.DNSHostName + '|' + $env:PROCESSOR_ARCHITECTURE)",
    ),
    network: powershell(
        "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { " +
        "$s = Get-NetAdapterStatistics -Name $_.Name -ErrorAction SilentlyContinue; " +
        "$ips = Get-NetIPAddress -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue; " +
        "$v4 = ($ips | Where-Object { $_.AddressFamily -eq 'IPv4' } | ForEach-Object { $_.IPAddress + '/' + $_.PrefixLength }) -join ','; " +
        "$v6 = ($ips | Where-Object { $_.AddressFamily -eq 'IPv6' } | ForEach-Object { ($_.IPAddress -replace '%.*', '') + '/' + $_.PrefixLength }) -join ','; " +
        "Write-Output ($_.Name + '|' + $_.MacAddress + '|' + $_.Status + '|' + $_.MtuSize + '|' + $_.Speed + '|' + " +
        "$s.ReceivedBytes + '|' + $s.SentBytes + '|' + $v4 + '|' + $v6) }",
    ),
};

// Detected OS per entry ("linux" | "windows"), so hosts are not re-probed on every poll cycle.
// Keyed by entry id and validated against host:port so a re-pointed entry is probed again.
const detectedOS = new Map();

const getCachedOS = (entry, host, port) => {
    const cached = detectedOS.get(entry.id);
    return cached && cached.host === host && cached.port === port ? cached.os : null;
};

// A host is only treated as Windows when PowerShell actually runs and reports the Win32NT platform;
// anything else (missing powershell, non-zero exit, unexpected output) falls back to the Linux path.
const isWindowsProbeResult = (result) =>
    Boolean(result?.success) && result.exitCode === 0 && (result.stdout || "").trim() === "Win32NT";

const execBatch = async (host, port, params, commandMap, jumpHosts, extraCommands = []) => {
    const commands = Object.entries(commandMap).map(([id, command]) => ({ id, command })).concat(extraCommands);
    const batch = await controlPlane.execCommandBatch(host, port, params, commands, jumpHosts);
    if (!batch.success) {
        throw new Error(batch.errorMessage || "Failed to connect to SSH host");
    }

    const results = {};
    const out = {};
    for (const r of batch.results || []) {
        results[r.id] = r;
        out[r.id] = r.success ? (r.stdout || "").trim() : "";
    }
    return { results, out };
};

const collectServerData = async (entry, identity, credentials) => {
    if (!controlPlane.hasEngine()) {
        return { status: "error", timestamp: new Date(), errorMessage: "No engine connected. Monitoring requires the Nexterm Engine." };
    }

    const host = entry.config?.ip;
    const port = entry.config?.port || 22;
    if (!host) {
        return { status: "error", timestamp: new Date(), errorMessage: "Missing host configuration" };
    }

    const params = buildSSHParams(identity, credentials);
    const jumpHosts = await resolveJumpHosts(entry);

    try {
        let os = getCachedOS(entry, host, port);
        let out;

        if (os !== "windows") {
            // Linux is the default path. On the first cycle the PowerShell probe rides along in the same
            // batch, so Linux hosts never pay an extra round-trip for OS detection.
            const probe = os ? [] : [{ id: WINDOWS_PROBE_ID, command: WINDOWS_PROBE_CMD }];
            const linux = await execBatch(host, port, params, COMMANDS, jumpHosts, probe);
            out = linux.out;

            if (!os) {
                os = isWindowsProbeResult(linux.results[WINDOWS_PROBE_ID]) ? "windows" : "linux";
                detectedOS.set(entry.id, { host, port, os });
                logger.verbose("Detected monitoring OS", { entryId: entry.id, host, os });
            }
        }

        if (os === "windows") {
            out = (await execBatch(host, port, params, WINDOWS_COMMANDS, jumpHosts)).out;
            return collectWindowsData(out);
        }

        return collectLinuxData(out);
    } catch (error) {
        detectedOS.delete(entry.id);
        logger.error("Error during monitoring data collection", { error: error.message, host });
        return { status: "offline", timestamp: new Date(), errorMessage: error.message };
    }
};

const collectLinuxData = (out) => {
    const memory = parseMemoryUsage(out.memory);
    return {
        status: "online",
        timestamp: new Date(),
        cpuUsage: parseCPUUsage(out.cpu),
        memoryUsage: memory.usage,
        memoryTotal: memory.total,
        disk: parseDiskUsage(out.lsblk, out.df),
        uptime: parseUptime(out.uptime),
        loadAverage: parseLoadAverage(out.loadAverage),
        processes: parseProcessCount(out.processCount),
        processList: parseProcessList(out.processList),
        osInfo: parseOSInfo(out.osRelease, out.kernel, out.arch, out.hostname),
        network: parseNetworkInterfaces(out.ifaceDetails, out.ipAddr),
    };
};

const collectWindowsData = (out) => {
    const memory = parseWindowsMemoryUsage(out.memory);
    return {
        status: "online",
        timestamp: new Date(),
        cpuUsage: parseWindowsCPUUsage(out.cpu),
        memoryUsage: memory.usage,
        memoryTotal: memory.total,
        disk: parseWindowsDiskUsage(out.disk),
        uptime: parseProcessCount(out.uptime),
        loadAverage: null,
        processes: parseProcessCount(out.processCount),
        processList: parseWindowsProcessList(out.processList),
        osInfo: parseWindowsOSInfo(out.osInfo),
        network: parseWindowsNetworkInterfaces(out.network),
    };
};

const splitLines = (output) => (output || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);

const parseWindowsCPUUsage = (output) => {
    try {
        const value = Math.round(Number.parseFloat(output));
        return Number.isFinite(value) ? value : null;
    } catch { return null; }
};

const parseWindowsMemoryUsage = (output) => {
    try {
        const [total, free] = splitLines(output).map(l => Number.parseInt(l, 10));
        if (!total) return { usage: null, total: null };
        return { usage: Math.round(((total - free) / total) * 100), total };
    } catch { return { usage: null, total: null }; }
};

const parseWindowsDiskUsage = (output) => {
    try {
        return splitLines(output).map(line => {
            const [device, size, free, fs, label] = line.split("|");
            const sizeBytes = Number.parseInt(size, 10) || 0;
            const freeBytes = Number.parseInt(free, 10) || 0;
            const used = Math.max(sizeBytes - freeBytes, 0);
            return {
                name: device.replace(":", ""),
                size: sizeBytes,
                model: label || null,
                serial: null,
                rotational: null,
                partitions: [{
                    name: device,
                    size: sizeBytes,
                    mountPoint: `${device}\\`,
                    type: fs || null,
                    used,
                    available: freeBytes,
                    usagePercent: sizeBytes > 0 ? Math.round((used / sizeBytes) * 100) : 0,
                }],
            };
        });
    } catch { return []; }
};

const parseWindowsProcessList = (output) => {
    try {
        return splitLines(output).map(line => {
            const p = line.split("|");
            if (p.length < 7) return null;
            return {
                user: p[0] || "SYSTEM", pid: Number.parseInt(p[1], 10) || 0, cpu: Number.parseFloat(p[2]) || 0, mem: Number.parseFloat(p[3]) || 0,
                vsz: Number.parseInt(p[4], 10) || 0, rss: Number.parseInt(p[5], 10) || 0, tty: "?", stat: "?",
                start: "", time: "", command: p.slice(6).join("|"),
            };
        }).filter(Boolean);
    } catch { return []; }
};

const parseWindowsOSInfo = (output) => {
    try {
        const [name, version, build, hostname, arch] = (output || "").trim().split("|");
        return { name: name || "Windows", version: version || "", kernel: build || "", hostname: hostname || "", architecture: arch || "" };
    } catch { return {}; }
};

const parseWindowsNetworkInterfaces = (output) => {
    try {
        return splitLines(output).map(line => {
            const [name, mac, state, mtu, speed, rxBytes, txBytes, ipv4, ipv6] = line.split("|");
            if (!name) return null;
            const speedBits = Number.parseInt(speed, 10);
            return {
                name,
                ipv4: ipv4 ? ipv4.split(",").filter(Boolean) : [],
                ipv6: ipv6 ? ipv6.split(",").filter(Boolean) : [],
                rxBytes: Number.parseInt(rxBytes, 10) || 0,
                txBytes: Number.parseInt(txBytes, 10) || 0,
                mac: mac ? mac.replaceAll("-", ":").toLowerCase() : null,
                state: state ? state.toLowerCase() : null,
                mtu: Number.parseInt(mtu, 10) || null,
                speed: speedBits > 0 ? Math.round(speedBits / 1000000) : null,
            };
        }).filter(Boolean);
    } catch (error) {
        logger.error("Error getting Windows network interfaces", { error: error.message });
        return [];
    }
};

const parseCPUUsage = (output) => {
    try {
        const vals = output.split(" ").filter(Boolean).slice(1).map(Number);
        return Math.round(((vals.reduce((a, b) => a + b, 0) - vals[3]) / vals.reduce((a, b) => a + b, 0)) * 100);
    } catch { return null; }
};

const parseMemoryUsage = (output) => {
    try {
        const parts = output.split("\n")[1].split(/\s+/);
        const total = Number.parseInt(parts[1]), available = Number.parseInt(parts[6] || parts[3]);
        return { usage: Math.round(((total - available) / total) * 100), total };
    } catch { return { usage: null, total: null }; }
};

const parseDiskUsage = (lsblkOutput, dfOutput) => {
    try {
        const usageMap = {};
        for (const line of dfOutput.split("\n").filter(Boolean)) {
            const p = line.trim().split(/\s+/);
            usageMap[p[0]] = {
                filesystem: p[0],
                type: p[1],
                size: Number.parseInt(p[2], 10) || 0,
                used: Number.parseInt(p[3], 10) || 0,
                available: Number.parseInt(p[4], 10) || 0,
                usagePercent: Number.parseInt(p[5], 10) || 0,
                mountPoint: p[6] || "",
            };
        }

        const disks = [];
        try {
            const lsblk = JSON.parse(lsblkOutput);
            for (const device of lsblk.blockdevices || []) {
                if (device.type !== "disk") continue;
                const disk = {
                    name: device.name,
                    size: Number.parseInt(device.size, 10) || 0,
                    model: device.model?.trim() || null,
                    serial: device.serial?.trim() || null,
                    rotational: device.rota === true || device.rota === "1",
                    partitions: [],
                };
                for (const child of device.children || []) {
                    if (child.type !== "part") continue;
                    const devPath = `/dev/${child.name}`;
                    const usage = usageMap[devPath] || {};
                    disk.partitions.push({
                        name: child.name,
                        size: Number.parseInt(child.size, 10) || 0,
                        mountPoint: child.mountpoint || usage.mountPoint || null,
                        type: usage.type || null,
                        used: usage.used || 0,
                        available: usage.available || 0,
                        usagePercent: usage.usagePercent || 0,
                    });
                }
                if (disk.partitions.length > 0 || device.mountpoint) {
                    if (device.mountpoint && disk.partitions.length === 0) {
                        const devPath = `/dev/${device.name}`;
                        const usage = usageMap[devPath] || {};
                        disk.partitions.push({
                            name: device.name,
                            size: Number.parseInt(device.size, 10) || 0,
                            mountPoint: device.mountpoint || usage.mountPoint || null,
                            type: usage.type || null,
                            used: usage.used || 0,
                            available: usage.available || 0,
                            usagePercent: usage.usagePercent || 0,
                        });
                    }
                    disks.push(disk);
                }
            }
        } catch {
            return Object.values(usageMap).map(u => ({
                name: u.filesystem.replace("/dev/", ""),
                size: u.size,
                model: null,
                serial: null,
                rotational: null,
                partitions: [{
                    name: u.filesystem.replace("/dev/", ""),
                    size: u.size,
                    mountPoint: u.mountPoint,
                    type: u.type,
                    used: u.used,
                    available: u.available,
                    usagePercent: u.usagePercent,
                }],
            }));
        }
        return disks;
    } catch { return []; }
};

const parseUptime = (output) => {
    try { return Math.floor(Number.parseFloat(output.split(" ")[0])) || null; }
    catch { return null; }
};

const parseLoadAverage = (output) => {
    try { return output ? output.split(" ").slice(0, 3).map(parseFloat) : null; }
    catch { return null; }
};

const parseProcessCount = (output) => {
    try { return Number.parseInt(output) || null; }
    catch { return null; }
};

const parseProcessList = (output) => {
    try {
        return output.split("\n").slice(1, 51)
            .filter(Boolean).map(line => {
                const p = line.trim().split(/\s+/);
                return p.length >= 11 ? {
                    user: p[0], pid: Number.parseInt(p[1]), cpu: Number.parseFloat(p[2]), mem: Number.parseFloat(p[3]),
                    vsz: Number.parseInt(p[4]), rss: Number.parseInt(p[5]), tty: p[6], stat: p[7],
                    start: p[8], time: p[9], command: p.slice(10).join(" ")
                } : null;
            }).filter(Boolean);
    } catch { return []; }
};

const parseOSInfo = (osRelease, kernel, arch, hostname) => {
    try {
        const info = { kernel, architecture: arch, hostname };
        osRelease.split("\n").forEach(line => {
            if (line.startsWith("NAME=")) info.name = line.split("=")[1].replaceAll('"', "");
            if (line.startsWith("VERSION=")) info.version = line.split("=")[1].replaceAll('"', "");
        });
        return info;
    } catch { return {}; }
};

const parseNetworkInterfaces = (ifaceDetails, ipOutput) => {
    try {
        const ifaceMap = {};
        for (const line of ifaceDetails.split("\n").filter(Boolean)) {
            const [name, mac, state, mtu, speed, rxBytes, txBytes] = line.split("\t");
            if (!name || name === "lo") continue;
            ifaceMap[name] = {
                name, ipv4: [], ipv6: [],
                rxBytes: Number.parseInt(rxBytes, 10) || 0,
                txBytes: Number.parseInt(txBytes, 10) || 0,
                mac: mac?.trim() || null,
                state: state?.trim() || null,
                mtu: Number.parseInt(mtu, 10) || null,
                speed: Number.parseInt(speed, 10) || null,
            };
        }

        for (const line of ipOutput.split("\n").filter(Boolean)) {
            const match = line.match(/^\d+:\s+(\S+)\s+inet6?\s+(\S+)/);
            if (!match) continue;
            const name = match[1].replace(/@.*$/, "");
            if (name === "lo") continue;
            if (!ifaceMap[name]) ifaceMap[name] = { name, ipv4: [], ipv6: [], rxBytes: 0, txBytes: 0 };
            const addr = match[2];
            if (addr.includes(":")) ifaceMap[name].ipv6.push(addr);
            else ifaceMap[name].ipv4.push(addr);
        }

        return Object.values(ifaceMap);
    } catch (error) {
        logger.error("Error getting network interfaces", { error: error.message });
        return [];
    }
};

const saveMonitoringData = async (entryId, data) => {
    try {
        await MonitoringData.create({
            entryId,
            timestamp: data.timestamp || new Date(),
            status: data.status,
            cpuUsage: data.cpuUsage == null ? null : Math.round(data.cpuUsage),
            memoryUsage: data.memoryUsage == null ? null : Math.round(data.memoryUsage),
            uptime: data.uptime,
            loadAverage: data.loadAverage,
            processes: data.processes,
            errorMessage: data.errorMessage,
        });

        await MonitoringSnapshot.upsert({
            entryId,
            updatedAt: new Date(),
            status: data.status,
            memoryTotal: data.memoryTotal,
            disk: data.disk,
            network: data.network,
            processList: data.processList,
            osInfo: data.osInfo,
        });
    } catch (error) {
        logger.error("Error saving monitoring data", { entryId, error: error.message });
    }
};

const cleanupOldData = async () => {
    try {
        const settings = await getMonitoringSettingsInternal();
        const retentionHours = settings?.dataRetentionHours || 24;
        const retentionMs = retentionHours * 60 * 60 * 1000;

        await MonitoringData.destroy({ where: { timestamp: { [Op.lt]: new Date(Date.now() - retentionMs) } } });
        logger.verbose("Cleaned up old monitoring data", { retentionHours });
    } catch (error) {
        logger.error("Error cleaning up monitoring data", { error: error.message });
    }
};

setInterval(cleanupOldData, 60 * 60 * 1000);

module.exports = { start, stop };
