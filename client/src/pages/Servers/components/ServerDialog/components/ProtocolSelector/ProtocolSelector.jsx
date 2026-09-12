import Checkbox from "@/common/components/Checkbox";
import { useTranslation } from "react-i18next";
import {
    SELECTABLE_PROTOCOLS, PROTOCOL_LABELS, DEFAULT_PORTS,
    getEnabledProtocolsFromConfig, getProtocolPortFromConfig,
} from "@/common/utils/ProtocolUtil.js";
import "./styles.sass";

/**
 * Re-derives the primary protocol (`config.protocol` / `config.port`) from the enabled protocol map.
 * Falls back to the first enabled protocol when the current primary was disabled.
 */
const syncPrimary = (config) => {
    const enabled = getEnabledProtocolsFromConfig(config);
    const primary = enabled.includes(config.protocol) ? config.protocol : enabled[0];

    if (!primary) {
        const { protocol, port, ...rest } = config;
        return rest;
    }

    return { ...config, protocol: primary, port: getProtocolPortFromConfig(config, primary) };
};

/**
 * @param {Array<{id:number,name:string}>} identityOptions - identities linked to the entry; when there are
 *        at least two, each enabled protocol can pick its own default identity.
 */
export const ProtocolSelector = ({ config, setConfig, identityOptions = [] }) => {
    const { t } = useTranslation();
    const showIdentityColumn = identityOptions.length > 1;

    const enabledProtocols = getEnabledProtocolsFromConfig(config);
    const primaryProtocol = enabledProtocols.includes(config?.protocol) ? config.protocol : enabledProtocols[0];

    const toggleProtocol = (protocol, checked) => {
        setConfig(prev => {
            const map = { ...(prev.protocols || {}) };
            const port = map[protocol]?.port ?? getProtocolPortFromConfig(prev, protocol) ?? DEFAULT_PORTS[protocol];
            map[protocol] = { ...(map[protocol] || {}), enabled: checked, port };

            if (protocol === "ssh" && checked && map.sftp === undefined) {
                map.sftp = { enabled: true, port };
            }

            return syncPrimary({ ...prev, protocols: map });
        });
    };

    const changePort = (protocol, value) => {
        setConfig(prev => {
            const map = { ...(prev.protocols || {}) };
            const previousPort = map[protocol]?.port;
            map[protocol] = { ...(map[protocol] || { enabled: true }), port: value };

            // SFTP rides on SSH: keep its port in lockstep as long as the user never gave it its own value.
            if (protocol === "ssh" && map.sftp && String(map.sftp.port ?? "") === String(previousPort ?? "")) {
                map.sftp = { ...map.sftp, port: value };
            }

            const next = { ...prev, protocols: map };
            next.port = getProtocolPortFromConfig(next, next.protocol);
            return next;
        });
    };

    const selectPrimary = (protocol) => {
        setConfig(prev => ({ ...prev, protocol, port: getProtocolPortFromConfig(prev, protocol) }));
    };

    const changeIdentity = (protocol, value) => {
        setConfig(prev => {
            const map = { ...(prev.protocols || {}) };
            const entry = { ...(map[protocol] || { enabled: true, port: DEFAULT_PORTS[protocol] }) };
            if (value) entry.identityId = Number.parseInt(value, 10);
            else delete entry.identityId;
            map[protocol] = entry;
            return { ...prev, protocols: map };
        });
    };

    return (
        <div className="protocol-selector">
            <div className="protocol-selector__header">
                <span className="protocol-selector__column protocol-selector__column--name" />
                {showIdentityColumn && (
                    <span className="protocol-selector__column protocol-selector__column--identity">{t("servers.dialog.protocols.identity")}</span>
                )}
                <span className="protocol-selector__column protocol-selector__column--port">{t("servers.dialog.protocols.port")}</span>
                <span className="protocol-selector__column protocol-selector__column--primary">{t("servers.dialog.protocols.primary")}</span>
            </div>

            {SELECTABLE_PROTOCOLS.map(protocol => {
                const enabled = enabledProtocols.includes(protocol);
                const isPrimary = enabled && protocol === primaryProtocol;
                const port = getProtocolPortFromConfig(config, protocol);
                const label = PROTOCOL_LABELS[protocol] || protocol.toUpperCase();
                const checkboxId = `protocol-enabled-${protocol}`;

                return (
                    <div key={protocol}
                         className={`protocol-selector__row${enabled ? " enabled" : ""}${isPrimary ? " primary" : ""}`}>
                        <div className="protocol-selector__column protocol-selector__column--name">
                            <Checkbox id={checkboxId} size="small" checked={enabled}
                                      onChange={(checked) => toggleProtocol(protocol, checked)} />
                            <label htmlFor={checkboxId} className="protocol-selector__label">{label}</label>
                        </div>

                        {showIdentityColumn && (
                            <div className="protocol-selector__column protocol-selector__column--identity">
                                <select className="protocol-selector__identity" disabled={!enabled}
                                        aria-label={`${label} ${t("servers.dialog.protocols.identity")}`}
                                        value={enabled ? String(config?.protocols?.[protocol]?.identityId ?? "") : ""}
                                        onChange={(event) => changeIdentity(protocol, event.target.value)}>
                                    <option value="">{t("servers.dialog.protocols.defaultIdentity")}</option>
                                    {identityOptions.map(identity => (
                                        <option key={identity.id} value={String(identity.id)}>{identity.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <div className="protocol-selector__column protocol-selector__column--port">
                            <input type="text" inputMode="numeric" className="protocol-selector__port"
                                   id={`protocol-port-${protocol}`} disabled={!enabled}
                                   aria-label={`${label} ${t("servers.dialog.protocols.port")}`}
                                   placeholder={String(DEFAULT_PORTS[protocol] ?? "")}
                                   value={enabled ? (port ?? "") : ""}
                                   onChange={(event) => changePort(protocol, event.target.value)} />
                        </div>

                        <div className="protocol-selector__column protocol-selector__column--primary">
                            <input type="radio" name="primary-protocol" className="protocol-selector__radio"
                                   id={`protocol-primary-${protocol}`} disabled={!enabled} checked={isPrimary}
                                   aria-label={`${label} ${t("servers.dialog.protocols.primary")}`}
                                   onChange={() => selectPrimary(protocol)} />
                        </div>
                    </div>
                );
            })}

            <p className="protocol-selector__hint">
                {enabledProtocols.length === 0
                    ? t("servers.dialog.protocols.noneEnabled")
                    : t("servers.dialog.protocols.hint")}
            </p>
        </div>
    );
};
