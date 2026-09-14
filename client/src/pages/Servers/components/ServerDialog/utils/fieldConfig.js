import { mdiInformationOutline, mdiAccountKeyOutline, mdiCogOutline } from "@mdi/js";
import { getEnabledProtocolsFromConfig, getProtocolPortFromConfig } from "@/common/utils/ProtocolUtil.js";

const AUTH_TYPE_ORDER = ["password-only", "password", "ssh", "both"];

/** Per-protocol capabilities; a multi-protocol entry gets the union of its enabled protocols. */
const PROTOCOL_FIELDS = {
    ssh: {
        showIpPort: true,
        showIdentities: true,
        showSettings: true,
        showMonitoring: true,
        showTerminalSettings: true,
        showJumpHosts: true,
        allowedAuthTypes: ["password", "ssh", "both"],
        showWakeOnLan: true,
    },
    telnet: {
        showIpPort: true,
        showIdentities: true,
        showSettings: true,
        showTerminalSettings: true,
        showTelnetAutoLogin: true,
        allowedAuthTypes: ["password", "password-only"],
        showWakeOnLan: true,
    },
    rdp: {
        showIpPort: true,
        showIdentities: true,
        showSettings: true,
        showKeyboardLayout: true,
        showDisplaySettings: true,
        showPerformanceSettings: true,
        showAudioSettings: true,
        showRdpSecurity: true,
        showJumpHosts: true,
        allowedAuthTypes: ["password-only", "password"],
        showWakeOnLan: true,
    },
    vnc: {
        showIpPort: true,
        showIdentities: true,
        showSettings: true,
        showDisplaySettings: true,
        showAudioSettings: true,
        showJumpHosts: true,
        allowedAuthTypes: ["password-only", "password"],
        showWakeOnLan: true,
    },
    spice: {
        showIpPort: true,
        showIdentities: true,
        showSettings: true,
        showDisplaySettings: true,
        showAudioSettings: true,
        showJumpHosts: true,
        allowedAuthTypes: ["password-only", "password"],
        showWakeOnLan: true,
    },
    demo: {
        showIpPort: false,
        showIdentities: false,
        showSettings: false,
    },
    sftp: {
        showIpPort: true,
        showIdentities: true,
        showSettings: true,
        showJumpHosts: true,
        allowedAuthTypes: ["password", "ssh", "both"],
        showWakeOnLan: true,
    },
    ftp: {
        showIpPort: true,
        showIdentities: true,
        showSettings: true,
        allowedAuthTypes: ["password"],
        showWakeOnLan: true,
    },
    ftps: {
        showIpPort: true,
        showIdentities: true,
        showSettings: true,
        allowedAuthTypes: ["password"],
        showWakeOnLan: true,
    },
};

const EMPTY_SERVER_FIELDS = {
    showProtocol: true,
    showIpPort: true,
    showIdentities: true,
    showSettings: true,
    showMonitoring: true,
    showKeyboardLayout: true,
    allowedAuthTypes: ["password", "ssh", "both"],
    showWakeOnLan: true,
};

const BOOLEAN_FLAGS = [
    "showIpPort", "showIdentities", "showSettings", "showMonitoring", "showKeyboardLayout",
    "showTerminalSettings", "showDisplaySettings", "showPerformanceSettings", "showAudioSettings",
    "showRdpSecurity", "showWakeOnLan", "showJumpHosts", "showTelnetAutoLogin",
];

const normalizeProtocols = (protocolOrList) => {
    if (Array.isArray(protocolOrList)) return protocolOrList.filter(Boolean);
    if (typeof protocolOrList === "string" && protocolOrList) return [protocolOrList];
    return [];
};

const mergeServerFields = (protocols) => {
    const merged = { showProtocol: true, allowedAuthTypes: [] };
    const authTypes = new Set();
    for (const flag of BOOLEAN_FLAGS) merged[flag] = false;

    for (const protocol of protocols) {
        const fields = PROTOCOL_FIELDS[protocol];
        if (!fields) continue;
        for (const flag of BOOLEAN_FLAGS) {
            if (fields[flag]) merged[flag] = true;
        }
        (fields.allowedAuthTypes || []).forEach(type => authTypes.add(type));
    }

    merged.allowedAuthTypes = AUTH_TYPE_ORDER.filter(type => authTypes.has(type));
    return merged;
};

/**
 * @param {string} type - entry type ("server", "pve-qemu", ...)
 * @param {string|string[]} protocols - the enabled protocol(s) of a server entry
 */
export const getFieldConfig = (type, protocols) => {
    if (type === "server") {
        const list = normalizeProtocols(protocols);
        if (list.length === 0) return { ...EMPTY_SERVER_FIELDS };
        return mergeServerFields(list);
    }

    if (type === "pve-shell" || type === "pve-lxc") {
        return {
            showProtocol: false,
            showIpPort: false,
            showIdentities: false,
            showSettings: false,
            showMonitoring: false,
            showKeyboardLayout: false,
        };
    }

    if (type === "pve-qemu") {
        return {
            showProtocol: false,
            showIpPort: false,
            showIdentities: false,
            showSettings: true,
            showMonitoring: false,
            showKeyboardLayout: false,
            showConsoleType: true,
            showDisplaySettings: true,
            showAudioSettings: true,
        };
    }

    return {
        showProtocol: true,
        showIpPort: true,
        showIdentities: true,
        showSettings: true,
        showMonitoring: true,
        showKeyboardLayout: false,
    };
};

export const getAvailableTabs = (type, protocols) => {
    const config = getFieldConfig(type, protocols);
    const tabs = [];

    tabs.push({ key: "details", label: "servers.dialog.tabs.details", icon: mdiInformationOutline });

    if (config.showIdentities) {
        tabs.push({ key: "identities", label: "servers.dialog.tabs.identities", icon: mdiAccountKeyOutline });
    }

    if (config.showSettings && (config.showMonitoring || config.showKeyboardLayout || config.showDisplaySettings || config.showAudioSettings || config.showWakeOnLan || config.showTerminalSettings || config.showJumpHosts || config.showTelnetAutoLogin)) {
        tabs.push({ key: "settings", label: "servers.dialog.tabs.settings", icon: mdiCogOutline });
    }

    return tabs;
};

const isValidPort = (value) => {
    const port = Number.parseInt(value, 10);
    return Number.isFinite(port) && port >= 0 && port <= 65535;
};

/**
 * Returns `true` when the dialog can be submitted. For server entries at least one protocol must be
 * enabled and every enabled protocol needs a valid port.
 */
export const validateRequiredFields = (type, protocols, name, config) => {
    if (!name) return false;

    if (type !== "server") return true;

    const enabled = Array.isArray(protocols) ? protocols : getEnabledProtocolsFromConfig(config);
    const fieldConfig = getFieldConfig(type, enabled);

    if (enabled.length === 0) return false;

    if (fieldConfig.showIpPort) {
        if (!config.ip) return false;
        for (const protocol of enabled) {
            if (!isValidPort(getProtocolPortFromConfig(config, protocol))) return false;
        }
    }

    return true;
};
