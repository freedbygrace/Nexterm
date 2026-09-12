import { isTauri, getActiveServerUrl } from "@/common/utils/TauriUtil.js";
import { isCredentiallessProtocol, getPrimaryProtocol } from "@/common/utils/ProtocolUtil.js";

export const getBaseUrl = () => {
    if (isTauri()) {
        const serverUrl = getActiveServerUrl();
        if (serverUrl) return serverUrl;
    }
    return "";
};

export const getWebSocketBaseUrl = () => {
    if (isTauri()) {
        const serverUrl = getActiveServerUrl();
        if (serverUrl) {
            const url = new URL(serverUrl);
            return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
        }
    }
    return "";
};

export const getWebSocketUrl = (path, params = {}) => {
    const baseUrl = getWebSocketBaseUrl();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    
    const url = baseUrl 
        ? `${baseUrl}${path}`
        : `${protocol}://${window.location.host}${path}`;
    
    const queryString = new URLSearchParams(params).toString();
    return queryString ? `${url}?${queryString}` : url;
};

export const getTabId = () => {
    let id = sessionStorage.getItem("nexterm_tab_id");
    if (!id) sessionStorage.setItem("nexterm_tab_id", id = `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    return id;
};

export const getBrowserId = () => {
    let id = localStorage.getItem("nexterm_browser_id");
    if (!id) localStorage.setItem("nexterm_browser_id", id = `browser_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    return id;
};

export { isCredentiallessProtocol };

/**
 * Whether connecting to `server` over `protocol` (defaults to the entry's primary protocol) needs an identity.
 */
export const requiresIdentity = (server, protocol = null) => {
    if (!server) return false;
    if (server.type?.startsWith("pve-")) return false;
    return !isCredentiallessProtocol(protocol || getPrimaryProtocol(server));
};

export const canConnectWithoutPrompt = (server, protocol = null) =>
    !requiresIdentity(server, protocol) || server?.identities?.length > 0;