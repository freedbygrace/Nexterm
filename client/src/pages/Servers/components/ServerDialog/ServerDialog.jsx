import { DialogProvider } from "@/common/components/Dialog";
import "./styles.sass";
import { useContext, useEffect, useState, useCallback, useRef, useMemo } from "react";
import DetailsPage from "@/pages/Servers/components/ServerDialog/pages/DetailsPage.jsx";
import Button from "@/common/components/Button";
import TabSwitcher from "@/common/components/TabSwitcher";
import { getRequest, patchRequest, putRequest } from "@/common/utils/RequestUtil.js";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import IdentityPage from "@/pages/Servers/components/ServerDialog/pages/IdentityPage.jsx";
import SettingsPage from "@/pages/Servers/components/ServerDialog/pages/SettingsPage.jsx";
import { IdentityContext } from "@/common/contexts/IdentityContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useTranslation } from "react-i18next";
import { getAvailableTabs, validateRequiredFields, getFieldConfig } from "./utils/fieldConfig.js";
import {
    DEFAULT_PORTS, GUAC_PROTOCOLS, PROTOCOL_LABELS, getEnabledProtocolsFromConfig, getProtocolPortFromConfig, seedProtocolMap,
} from "@/common/utils/ProtocolUtil.js";
import Icon from "@mdi/react";
import * as mdiIcons from "@mdi/js";

const PROTOCOL_DEFAULT_ICONS = { ssh: "mdiConsole", telnet: "mdiConsole", rdp: "mdiMicrosoftWindows", vnc: "mdiMonitor", spice: "mdiMonitor", sftp: "mdiFolderNetwork", ftp: "mdiFolderNetwork", ftps: "mdiFolderNetwork", demo: "mdiFlaskOutline" };

/** Settings that only apply to graphical (RDP/VNC) sessions. */
const GUAC_ONLY_SETTINGS = [
    "rdpSecurity", "colorDepth", "resizeMethod", "enableAudio", "enableWallpaper", "enableTheming",
    "enableFontSmoothing", "enableFullWindowDrag", "enableDesktopComposition", "enableMenuAnimations",
];

/**
 * Legacy entries only carry `protocol`/`port`; expand them into a `protocols` map so the dialog can
 * edit them like any multi-protocol entry.
 */
const normalizeServerConfig = (rawConfig, type) => {
    const parsed = rawConfig || {};
    if (type !== "server" || parsed.protocol === "demo" || !parsed.protocol) return parsed;
    if (parsed.protocols && typeof parsed.protocols === "object") return parsed;
    return { ...parsed, protocols: seedProtocolMap(parsed.protocol, parsed.port) };
};

export const ServerDialog = ({ open, onClose, currentFolderId, currentOrganizationId, editServerId, initialProtocol }) => {
    const { t } = useTranslation();

    const { loadServers } = useContext(ServerContext);
    const { loadIdentities, identities: allIdentities } = useContext(IdentityContext);
    const { sendToast } = useToast();

    const getProtocolIcon = (protocol, type) => {
        if (type?.startsWith('pve')) return "mdiServerNetwork";
        return { ssh: "mdiConsole", telnet: "mdiConsole", rdp: "mdiMonitor", vnc: "mdiDesktopClassic", sftp: "mdiFolderNetwork", ftp: "mdiFolderNetwork", ftps: "mdiFolderNetwork", demo: "mdiFlaskOutline" }[protocol] || "mdiServerNetwork";
    };

    const [name, setName] = useState("");
    const [icon, setIcon] = useState(null);
    const [identities, setIdentities] = useState([]);
    const [config, setConfig] = useState({});
    const [monitoringEnabled, setMonitoringEnabled] = useState(false);
    const [entryType, setEntryType] = useState("server");

    const [identityUpdates, setIdentityUpdates] = useState({});

    const [activeTab, setActiveTab] = useState(0);

    const initialValues = useRef({ name: '', icon: null, config: {}, monitoringEnabled: false });

    const enabledProtocols = useMemo(() => getEnabledProtocolsFromConfig(config), [config]);
    const protocolsKey = enabledProtocols.join(",");
    const fieldConfig = useMemo(() => getFieldConfig(entryType, enabledProtocols), [entryType, protocolsKey]);
    const tabs = useMemo(() => getAvailableTabs(entryType, enabledProtocols), [entryType, protocolsKey]);

    const primaryProtocol = entryType === "server"
        ? (enabledProtocols.includes(config.protocol) ? config.protocol : enabledProtocols[0])
        : undefined;

    const normalizeIdentity = (identity) => {
        const normalized = { ...identity };
        if (normalized.username === "") normalized.username = undefined;

        if (!identity.passwordTouched && normalized.password === "") normalized.password = undefined;
        if (!identity.passphraseTouched && normalized.passphrase === "") normalized.passphrase = undefined;
        if (normalized.sshCertificate === null) normalized.sshCertificate = undefined;

        if (normalized.sshKey === null) normalized.sshKey = undefined;
        return normalized;
    };

    const buildIdentityPayload = (identity) => {
        const payload = {
            name: identity.name,
            username: identity.authType === 'password-only' ? undefined : identity.username,
            type: identity.authType,
        };

        if (identity.organizationId) {
            payload.organizationId = identity.organizationId;
        }

        const hasPassphrase = typeof identity.passphrase === "string" && identity.passphrase.length > 0;

        if (identity.authType === 'password' || identity.authType === 'password-only') {
            if (identity.passwordTouched || identity.password) {
                payload.password = identity.password;
            }
        } else if (identity.authType === 'both') {
            if (identity.passwordTouched || identity.password) {
                payload.password = identity.password;
            }
            payload.sshKey = identity.sshKey;
            payload.sshCertificate = identity.sshCertificate;
            if (hasPassphrase) {
                payload.passphrase = identity.passphrase;
            }
        } else {
            payload.sshKey = identity.sshKey;
            payload.sshCertificate = identity.sshCertificate;
            if (hasPassphrase) {
                payload.passphrase = identity.passphrase;
            }
        }

        return payload;
    };

    const updateIdentities = async () => {
        const allIdentityIds = new Set();

        identities.forEach(id => allIdentityIds.add(id));

        for (const identityId of Object.keys(identityUpdates)) {
            const identity = normalizeIdentity(identityUpdates[identityId]);

            if (identityId.startsWith("new-")) {
                const payload = buildIdentityPayload(identity);
                try {
                    const result = await putRequest("identities", payload);
                    if (result.id) allIdentityIds.add(result.id);
                } catch (error) {
                    sendToast("Error", t(error.message) || t("servers.messages.createIdentityFailed"));
                    console.error(error);
                    return null;
                }
            } else if (identity.linked) {
                allIdentityIds.add(parseInt(identityId));
            } else {
                const payload = buildIdentityPayload(identity);
                try {
                    await patchRequest("identities/" + identityId, payload);
                    allIdentityIds.add(parseInt(identityId));
                } catch (error) {
                    sendToast("Error", t(error.message) || t("servers.messages.updateIdentityFailed"));
                    console.error(error);
                    return null;
                }
            }
        }

        return Array.from(allIdentityIds);
    };

    const buildConfig = () => {
        const finalConfig = { ...config };

        if (fieldConfig.showMonitoring) {
            finalConfig.monitoringEnabled = monitoringEnabled;
        } else {
            delete finalConfig.monitoringEnabled;
        }

        if (!fieldConfig.showIpPort) {
            delete finalConfig.ip;
            delete finalConfig.port;
        }

        if (entryType !== "server") {
            delete finalConfig.protocol;
            delete finalConfig.protocols;
        } else if (finalConfig.protocol === "demo") {
            delete finalConfig.protocols;
        } else if (enabledProtocols.length > 0) {
            // `protocols` is the source of truth; `protocol`/`port` mirror the primary for compatibility.
            const protocols = { ...(finalConfig.protocols || {}) };
            for (const protocol of enabledProtocols) {
                if (!protocols[protocol]) {
                    protocols[protocol] = { enabled: true, port: getProtocolPortFromConfig(finalConfig, protocol) };
                }
            }
            finalConfig.protocols = protocols;
            finalConfig.protocol = primaryProtocol;
            finalConfig.port = getProtocolPortFromConfig(finalConfig, primaryProtocol);
        }

        if (!fieldConfig.showKeyboardLayout) {
            delete finalConfig.keyboardLayout;
        }

        if (!fieldConfig.showJumpHosts) {
            delete finalConfig.jumpHosts;
        }

        if (!enabledProtocols.includes("telnet")) {
            delete finalConfig.telnetUsernamePrompt;
            delete finalConfig.telnetPasswordPrompt;
        }

        if (entryType === "server" && !enabledProtocols.some(p => GUAC_PROTOCOLS.includes(p))) {
            for (const key of GUAC_ONLY_SETTINGS) delete finalConfig[key];
        }

        return finalConfig;
    };

    const createServer = async () => {
        try {
            const serverIdentityIds = await updateIdentities();
            if (serverIdentityIds === null) return;

            loadIdentities();

            const result = await putRequest("entries", {
                name,
                icon,
                config: buildConfig(),
                folderId: currentFolderId,
                organizationId: currentOrganizationId,
                identities: serverIdentityIds,
                type: "server"
            });

            loadServers();
            if (result.id) {
                sendToast("Success", t("servers.messages.serverCreated"));
                onClose();
            }
        } catch (error) {
            sendToast("Error", error.message || t("servers.messages.createFailed"));
            console.error(error);
        }
    };

    const patchServer = async () => {
        try {
            const serverIdentityIds = await updateIdentities();
            if (serverIdentityIds === null) return;

            await patchRequest("entries/" + editServerId, {
                name, icon,
                config: buildConfig(),
                identities: serverIdentityIds
            });

            loadServers();
            sendToast("Success", t("servers.messages.serverUpdated"));
            onClose();
        } catch (error) {
            sendToast("Error", error.message || t("servers.messages.updateFailed"));
            console.error(error);
        }
    };

    const handleSubmit = useCallback(() => {
        if (entryType === "server" && enabledProtocols.length === 0) {
            sendToast("Error", t("servers.dialog.messages.noProtocolEnabled"));
            return;
        }
        if (!validateRequiredFields(entryType, enabledProtocols, name, config)) {
            sendToast("Error", t("servers.messages.fillRequiredFields"));
            return;
        }
        editServerId ? patchServer() : createServer();
    }, [name, icon, editServerId, identityUpdates, currentFolderId, config, monitoringEnabled, entryType, enabledProtocols, t]);

    useEffect(() => {
        if (!open) return;

        if (editServerId) {
            getRequest("entries/" + editServerId).then((server) => {
                const type = server.type || "server";
                setName(server.name);
                setIcon(server.icon || null);
                setIdentities(server.identities);
                setEntryType(type);

                const parsedConfig = normalizeServerConfig(server.config, type);
                setConfig(parsedConfig);
                setMonitoringEnabled(Boolean(parsedConfig.monitoringEnabled ?? true));
                initialValues.current = {
                    name: server.name,
                    icon: server.icon || null,
                    config: JSON.stringify(parsedConfig),
                    monitoringEnabled: Boolean(parsedConfig.monitoringEnabled ?? true)
                };
            });
        } else {
            setName("");
            setIcon(null);
            setIdentities([]);
            setEntryType("server");

            if (initialProtocol) {
                const initialConfig = initialProtocol === "demo"
                    ? { protocol: "demo" }
                    : {
                        protocol: initialProtocol,
                        port: DEFAULT_PORTS[initialProtocol] ?? "",
                        protocols: seedProtocolMap(initialProtocol),
                    };

                setConfig(initialConfig);
                const defaultIcon = PROTOCOL_DEFAULT_ICONS[initialProtocol] || null;
                setIcon(defaultIcon);
                initialValues.current = {
                    name: '',
                    icon: defaultIcon,
                    config: JSON.stringify(initialConfig),
                    monitoringEnabled: false
                };
            } else {
                setConfig({});
                initialValues.current = { name: '', icon: null, config: '{}', monitoringEnabled: false };
            }
            setMonitoringEnabled(false);
        }

        setIdentityUpdates({});
        setActiveTab(0);
    }, [open, editServerId, initialProtocol]);

    useEffect(() => {
        if (activeTab >= tabs.length) setActiveTab(0);
    }, [activeTab, tabs.length]);

    useEffect(() => {
        if (!open) return;

        const submitOnEnter = (event) => {
            if (event.key === "Enter") {
                handleSubmit();
            }
        };

        document.addEventListener("keydown", submitOnEnter);

        return () => {
            document.removeEventListener("keydown", submitOnEnter);
        };
    }, [open, handleSubmit]);

    const refreshIdentities = () => {
        if (!editServerId) return;
        getRequest("servers/" + editServerId).then((server) => setIdentities(server.identities));
    };

    // Saved identities linked to this entry (unsaved ones have no id yet), for per-protocol defaults.
    const linkedIdentityOptions = useMemo(() => (identities || [])
        .map(id => (allIdentities || []).find(identity => identity.id === id))
        .filter(Boolean)
        .map(identity => ({ id: identity.id, name: identity.name })), [identities, allIdentities]);

    const isDirty = name !== initialValues.current.name ||
                     icon !== initialValues.current.icon ||
                     JSON.stringify(config) !== initialValues.current.config ||
                     monitoringEnabled !== initialValues.current.monitoringEnabled ||
                     Object.keys(identityUpdates).length > 0;

    const tabSwitcherTabs = useMemo(() => tabs.map((tab, index) => ({
        key: index.toString(),
        label: t(tab.label),
        icon: tab.icon
    })), [tabs, t]);

    const badgeProtocols = entryType === "server"
        ? (config.protocol === "demo" ? ["demo"] : enabledProtocols)
        : [];

    return (
        <DialogProvider open={open} onClose={onClose} isDirty={isDirty}>
            <div className="server-dialog">
                <div className="server-dialog-header">
                    <div className="dialog-icon">
                        <Icon path={mdiIcons[getProtocolIcon(primaryProtocol || config.protocol, entryType)] || mdiIcons.mdiServerNetwork} size={1} />
                    </div>
                    <div className="server-dialog-title">
                        <h2>
                            {editServerId
                                ? t("servers.dialog.editServer")
                                : primaryProtocol
                                    ? t("servers.dialog.addProtocolServer", { protocol: (PROTOCOL_LABELS[primaryProtocol] || primaryProtocol).toUpperCase() })
                                    : t("servers.dialog.addServer")
                            }
                        </h2>
                        {badgeProtocols.length > 0 && (
                            <div className="protocol-badges">
                                {badgeProtocols.map(protocol => (
                                    <span key={protocol}
                                          className={`protocol-badge${protocol === primaryProtocol ? " primary" : ""}`}>
                                        {(PROTOCOL_LABELS[protocol] || protocol).toUpperCase()}
                                    </span>
                                ))}
                            </div>
                        )}
                        {entryType?.startsWith('pve') && (
                            <span className="protocol-badge">
                                {entryType === 'pve-shell' ? 'PVE SHELL' :
                                 entryType === 'pve-lxc' ? 'PVE LXC' :
                                 entryType === 'pve-qemu' ? 'PVE QEMU' : 'PVE'}
                            </span>
                        )}
                    </div>
                </div>

                {tabs.length > 1 && (
                    <div className="server-dialog-tabs">
                        <TabSwitcher
                            tabs={tabSwitcherTabs}
                            activeTab={activeTab.toString()}
                            onTabChange={(tabKey) => setActiveTab(parseInt(tabKey))}
                            variant="dialog"
                        />
                    </div>
                )}

                <form className="server-dialog-content" onSubmit={(e) => e.preventDefault()} autoComplete="on">
                    {activeTab === 0 && <DetailsPage name={name} setName={setName}
                                                     icon={icon} setIcon={setIcon}
                                                     config={config} setConfig={setConfig}
                                                     fieldConfig={fieldConfig} entryType={entryType}
                                                     identityOptions={linkedIdentityOptions} />}
                    {activeTab === 1 && tabs[1]?.key === "identities" &&
                        <IdentityPage serverIdentities={identities} setIdentityUpdates={setIdentityUpdates}
                                      identityUpdates={identityUpdates} setIdentities={setIdentities}
                                      currentOrganizationId={currentOrganizationId} allowedAuthTypes={fieldConfig.allowedAuthTypes}
                                      serverName={name} />}
                    {tabs.find((tab, idx) => idx === activeTab && tab.key === "settings") &&
                        <SettingsPage config={config} setConfig={setConfig}
                                      monitoringEnabled={monitoringEnabled} setMonitoringEnabled={setMonitoringEnabled}
                                      fieldConfig={fieldConfig} editServerId={editServerId} />}
                </form>

                <Button className="server-dialog-button" onClick={handleSubmit}
                        text={editServerId ? t("servers.dialog.actions.save") : t("servers.dialog.actions.create")} />
            </div>

        </DialogProvider>
    );
};
