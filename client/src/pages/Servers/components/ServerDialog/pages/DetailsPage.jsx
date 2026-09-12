import { mdiFormTextbox, mdiIp, mdiEthernet } from "@mdi/js";
import Input from "@/common/components/IconInput";
import SelectBox from "@/common/components/SelectBox";
import IconChooser from "../components/IconChooser";
import ProtocolSelector from "../components/ProtocolSelector";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { getRequest } from "@/common/utils/RequestUtil.js";

const DetailsPage = ({name, setName, icon, setIcon, config, setConfig, fieldConfig, entryType = "server"}) => {
    const { t } = useTranslation();
    const [engines, setEngines] = useState([]);

    useEffect(() => {
        getRequest("engines").then(data => setEngines(data || [])).catch(() => {});
    }, []);

    const engineOptions = engines.map(e => ({
        label: `${e.name}${e.connected ? "" : " " + t("servers.dialog.engineOffline")}`,
        value: String(e.id),
    }));

    const showEngineSelect = engines.length > 1;
    const showProtocolSelector = entryType === "server" && fieldConfig.showProtocol && config.protocol !== "demo";
    
    return (
        <>
            <div className="name-row">
                <div className="form-group">
                    <label htmlFor="name">{t("servers.dialog.fields.name")}</label>
                    <Input icon={mdiFormTextbox} type="text" placeholder={t("servers.dialog.placeholders.serverName")} 
                           id="name" autoComplete="off" value={name} setValue={setName} />
                </div>
                <div className="form-group">
                    <label>{t("servers.dialog.fields.icon")}</label>
                    <IconChooser selected={icon} setSelected={setIcon} />
                </div>
            </div>

            {showEngineSelect && (
                <div className="form-group">
                    <label>{t("servers.dialog.fields.engine")}</label>
                    <SelectBox
                        options={engineOptions}
                        selected={config.engineId ? String(config.engineId) : engineOptions[0]?.value}
                        setSelected={(value) => setConfig(prev => ({ ...prev, engineId: value }))}
                    />
                </div>
            )}
            
            {fieldConfig.showIpPort && (
                <>
                    {showProtocolSelector ? (
                        <>
                            <div className="form-group">
                                <label htmlFor="ip">{t("servers.dialog.fields.serverIp")}</label>
                                <Input icon={mdiIp} type="text" placeholder={t("servers.dialog.placeholders.serverIp")} 
                                       id="ip" autoComplete="off" value={config.ip || ""} 
                                       setValue={(value) => setConfig(prev => ({ ...prev, ip: value }))} />
                            </div>
                            <div className="form-group">
                                <label>{t("servers.dialog.fields.protocols")}</label>
                                <ProtocolSelector config={config} setConfig={setConfig} />
                            </div>
                        </>
                    ) : (
                        <div className="address-row">
                            <div className="form-group">
                                <label htmlFor="ip">{t("servers.dialog.fields.serverIp")}</label>
                                <Input icon={mdiIp} type="text" placeholder={t("servers.dialog.placeholders.serverIp")} 
                                       id="ip" autoComplete="off" value={config.ip || ""} 
                                       setValue={(value) => setConfig(prev => ({ ...prev, ip: value }))} />
                            </div>
                            <div className="form-group">
                                <label htmlFor="port">{t("servers.dialog.fields.port")}</label>
                                <input type="text" placeholder={t("servers.dialog.placeholders.port")} 
                                       value={config.port || ""} className="small-input" id="port"
                                       onChange={(e) => setConfig(prev => ({ ...prev, port: e.target.value }))} />
                            </div>
                        </div>
                    )}
                    {config.wakeOnLanEnabled && (
                        <>
                            <div className="form-group">
                                <label htmlFor="macAddress">{t("servers.dialog.fields.macAddress")}</label>
                                <Input icon={mdiEthernet} type="text" placeholder={t("servers.dialog.placeholders.macAddress")}
                                       id="macAddress" autoComplete="off" value={config.macAddress || ""}
                                       setValue={(value) => setConfig(prev => ({ ...prev, macAddress: value }))} />
                            </div>
                            <div className="form-group">
                                <label htmlFor="wolBroadcastAddress">{t("servers.dialog.fields.wolBroadcastAddress")}</label>
                                <Input icon={mdiIp} type="text" placeholder={t("servers.dialog.placeholders.wolBroadcastAddress")}
                                       id="wolBroadcastAddress" autoComplete="off" value={config.wolBroadcastAddress || ""}
                                       setValue={(value) => setConfig(prev => ({ ...prev, wolBroadcastAddress: value }))} />
                            </div>
                        </>
                    )}
                </>
            )}
        </>
    );
}

export default DetailsPage;