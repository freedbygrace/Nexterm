import "./styles.sass";
import ServerList from "@/pages/Servers/components/ServerList";
import { useContext, useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import WelcomePanel from "@/pages/Servers/components/WelcomePanel";
import ServerDialog from "@/pages/Servers/components/ServerDialog";
import ViewContainer from "@/pages/Servers/components/ViewContainer";
import ProxmoxDialog from "@/pages/Servers/components/ProxmoxDialog";
import SSHConfigImportDialog from "@/pages/Servers/components/SSHConfigImportDialog";
import EntryImportDialog from "@/pages/Servers/components/EntryImportDialog";
import ConnectionReasonDialog from "@/pages/Servers/components/ConnectionReasonDialog";
import DirectConnectDialog from "@/pages/Servers/components/DirectConnectDialog";
import FileEditorWindow from "@/common/components/FileEditorWindow";
import FilePreviewWindow from "@/common/components/FilePreviewWindow";
import { useSessionLayout } from "@/pages/Servers/components/ViewContainer/hooks/useSessionLayout.js";
import { useActiveSessions } from "@/common/contexts/SessionContext.jsx";
import { useLiveSessions } from "@/common/contexts/LiveSessionContext.jsx";
import { usePreferences } from "@/common/contexts/PreferencesContext.jsx";
import { useAutoReconnect } from "@/common/hooks/useAutoReconnect.js";
import { useLocation, useNavigate } from "react-router-dom";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { StateStreamContext, STATE_TYPES } from "@/common/contexts/StateStreamContext.jsx";
import { isTauri } from "@/common/utils/TauriUtil.js";
import { getTabId, getBrowserId, requiresIdentity, canConnectWithoutPrompt } from "@/common/utils/ConnectionUtil.js";
import { getRendererForProtocol, getSessionTypeForProtocol, getPrimaryProtocol } from "@/common/utils/ProtocolUtil.js";

/** Session types the view renders by (terminal, file manager, remote browser); see ViewContainer. */
const RENDERER_OVERRIDES = ["sftp", "web", "terminal"];
import { postRequest, deleteRequest, patchRequest, getRequest } from "@/common/utils/RequestUtil";

let reconnectKeySeq = 0;
// Stable per-tab key that survives the session-id change on each reconnect.
// Avoids crypto.randomUUID (unavailable in non-secure http contexts, e.g. LAN IP).
const makeReconnectKey = () => `rk-${Date.now().toString(36)}-${(reconnectKeySeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const Servers = () => {

    const [serverDialogOpen, setServerDialogOpen] = useState(false);
    const [serverDialogProtocol, setServerDialogProtocol] = useState(null);
    const [proxmoxDialogOpen, setProxmoxDialogOpen] = useState(false);
    const [sshConfigImportDialogOpen, setSSHConfigImportDialogOpen] = useState(false);
    const [entryImportDialogOpen, setEntryImportDialogOpen] = useState(false);
    const [connectionReasonDialogOpen, setConnectionReasonDialogOpen] = useState(false);
    const [directConnectDialogOpen, setDirectConnectDialogOpen] = useState(false);
    const [directConnectProtocol, setDirectConnectProtocol] = useState(null);
    const [directConnectServer, setDirectConnectServer] = useState(null);
    const [directConnectPlacement, setDirectConnectPlacement] = useState(null);
    const [pendingConnection, setPendingConnection] = useState(null);
    const [openFileEditors, setOpenFileEditors] = useState([]);
    const [mobileServerListOpen, setMobileServerListOpen] = useState(false);
    const [leftPaneSlot, setLeftPaneSlot] = useState(null);

    const [currentFolderId, setCurrentFolderId] = useState(null);
    const [currentOrganizationId, setCurrentOrganizationId] = useState(null);
    const [editServerId, setEditServerId] = useState(null);
    const { activeSessions, setActiveSessions, activeSessionId, setActiveSessionId, poppedOutSessions, sessionGroups, setSessionGroups } = useActiveSessions();
    const { liveSessions } = useLiveSessions();
    const { getServerById, servers } = useContext(ServerContext);
    const { registerHandler, isConnected } = useContext(StateStreamContext);
    const { autoReconnect } = usePreferences();
    const location = useLocation();
    const navigate = useNavigate();

    const activeGroupId = activeSessions.find(s => s.id === activeSessionId)?.groupId ?? null;

    const layoutPersistTimersRef = useRef(new Map());
    const persistGroupLayout = useCallback((groupId, layout) => {
        if (!groupId) return;
        const timers = layoutPersistTimersRef.current;
        clearTimeout(timers.get(groupId));
        timers.set(groupId, setTimeout(() => {
            timers.delete(groupId);
            patchRequest(`/connections/groups/${groupId}`, { layout: layout || null })
                .catch(error => console.debug("Failed to persist group layout:", error));
        }, 400));
    }, []);

    const sessionLayout = useSessionLayout(activeGroupId, persistGroupLayout);

    const [hibernatedSessions, setHibernatedSessions] = useState([]);
    const closingSessionsRef = useRef(new Set());
    const erroredSessionsRef = useRef(new Map());
    const reconnectReplacementsRef = useRef(new Map());
    // new session id -> groupId a reconnected session re-joins, until the server confirms it
    const pendingGroupAssignmentsRef = useRef(new Map());
    const autoReconnectRef = useRef(null);

    const markSessionErrored = useCallback((sessionId, message) => {
        if (erroredSessionsRef.current.has(sessionId)) return;
        erroredSessionsRef.current.set(sessionId, message);
        autoReconnectRef.current?.handleSessionErrored(sessionId);
    }, []);

    const getSessionError = useCallback((sessionId) => {
        return erroredSessionsRef.current.get(sessionId) || null;
    }, []);

    const visibleSessions = activeSessions.filter(s => !poppedOutSessions.includes(s.id));

    useEffect(() => {
        const handleToggle = () => setMobileServerListOpen(prev => !prev);
        window.addEventListener('toggleServerList', handleToggle);
        return () => window.removeEventListener('toggleServerList', handleToggle);
    }, []);

    useEffect(() => {
        setLeftPaneSlot(document.getElementById("left-pane-slot"));
    }, []);

    const handleConnectionsUpdate = useCallback((payload) => {
        if (!servers) return;
        const sessions = Array.isArray(payload) ? payload : (payload?.sessions || []);
        const groups = Array.isArray(payload) ? [] : (payload?.groups || []);
        setSessionGroups(groups);
        const mappedSessions = sessions.map(session => {
            const server = getServerById(session.entryId);
            if (!server) return null;
            return {
                id: session.sessionId,
                // A session may run over a non-primary protocol of the entry; keep its own renderer.
                server: session.configuration.renderer ? { ...server, renderer: session.configuration.renderer } : server,
                identity: session.configuration.identityId,
                isHibernated: session.isHibernated,
                lastActivity: session.lastActivity,
                // Only a renderer override counts; servers before 1.5.2 also stored the protocol name here.
                type: RENDERER_OVERRIDES.includes(session.configuration.type) ? session.configuration.type
                    : getSessionTypeForProtocol(session.configuration.protocol) || undefined,
                protocol: session.configuration.protocol || undefined,
                organizationId: session.organizationId,
                organizationName: session.organizationName,
                osName: session.osName || null,
                scriptId: session.configuration.scriptId || undefined,
                shareId: session.shareId || null,
                shareWritable: session.shareWritable || false,
                participants: session.participants || [],
                groupId: session.groupId || null,
            };
        }).filter(Boolean);

        const closingSessions = closingSessionsRef.current;
        const activeMapped = mappedSessions.filter(s => !s.isHibernated && !closingSessions.has(s.id));
        const hibernatedMapped = mappedSessions.filter(s => s.isHibernated);
        
        const serverSessionIds = new Set(sessions.map(s => s.sessionId));
        closingSessions.forEach(id => {
            if (!serverSessionIds.has(id)) {
                closingSessions.delete(id);
            }
        });
        
        const newActiveIds = new Set(activeMapped.map(s => s.id));
        let mergedSessions = [];

        setActiveSessions(prev => {
            const prevMap = new Map(prev.map(s => [s.id, s]));
            const localOnly = prev.filter(s => s.type === "notes" || s.isJoined);
            const merged = activeMapped.map(newSession => {
                const existing = prevMap.get(newSession.id);
                const reconnectKey = existing?.reconnectKey || makeReconnectKey();
                if (newSession.groupId) pendingGroupAssignmentsRef.current.delete(newSession.id);
                const groupId = newSession.groupId ?? pendingGroupAssignmentsRef.current.get(newSession.id) ?? null;
                return existing
                    ? { ...newSession, reconnectKey, groupId, scriptId: existing.scriptId || newSession.scriptId, scriptName: existing.scriptName, osName: newSession.osName || existing.osName }
                    : { ...newSession, reconnectKey, groupId };
            });
            const mergedIds = new Set(merged.map(s => s.id));
            const erroredPinned = prev.filter(s =>
                erroredSessionsRef.current.has(s.id) && !mergedIds.has(s.id) && s.type !== "notes"
            );
            mergedSessions = [...merged, ...erroredPinned, ...localOnly];
            return mergedSessions;
        });
        setHibernatedSessions(hibernatedMapped);

        setActiveSessionId(prev => {
            if (prev && (newActiveIds.has(prev) || mergedSessions.some(s => s.id === prev))) return prev;
            return mergedSessions.at(-1)?.id || null;
        });
    }, [servers, getServerById, setActiveSessions, setActiveSessionId, setSessionGroups]);

    useEffect(() => {
        if (servers) return registerHandler(STATE_TYPES.CONNECTIONS, handleConnectionsUpdate);
    }, [servers, registerHandler, handleConnectionsUpdate]);

    const prevGroupIdsRef = useRef(new Set());
    useEffect(() => {
        const currentIds = new Set(sessionGroups.map(g => g.groupId));
        prevGroupIdsRef.current.forEach(id => {
            if (!currentIds.has(id)) sessionLayout.removeGroupState(id);
        });
        prevGroupIdsRef.current = currentIds;
        sessionGroups.forEach(group => {
            const memberIds = activeSessions.filter(s => (s.groupId ?? null) === group.groupId).map(s => s.id);
            sessionLayout.hydrateGroup(group.groupId, group.layout, memberIds);
        });
    }, [sessionGroups, activeSessions, sessionLayout]);

    const findOrganizationForServer = (serverIdNum, entries, currentOrg = null) => {
        for (const entry of entries) {
            if ((entry.type === "server" || entry.type === "pve-server") && entry.id === serverIdNum) {
                return currentOrg;
            } else if (entry.type === "organization") {
                const found = findOrganizationForServer(serverIdNum, entry.entries, entry);
                if (found) return found;
            } else if (entry.type === "folder" && entry.entries) {
                const found = findOrganizationForServer(serverIdNum, entry.entries, currentOrg);
                if (found) return found;
            }
        }
        return null;
    };

    const checkConnectionReasonRequired = (serverId, servers) => {
        if (!servers || !serverId) return false;

        return findOrganizationForServer(parseInt(serverId), servers)?.requireConnectionReason || false;
    };

    /**
     * @param {string|null} protocol - which of the entry's enabled protocols to open; null = primary.
     */
    const connectToServer = async (serverId, identity, overrideRenderer, placement = null, protocol = null) => {
        const server = getServerById(serverId);
        const targetProtocol = protocol || (server ? getPrimaryProtocol(server) : null);

        const hibernated = hibernatedSessions.find(s => s.server.id === serverId && s.identity === identity?.id
            && (s.protocol || getPrimaryProtocol(s.server)) === targetProtocol);
        if (hibernated) {
            sessionLayout.placeSession(hibernated.id, placement);
            resumeConnection(hibernated.id);
            return;
        }

        if (server && !canConnectWithoutPrompt(server, targetProtocol)) {
            openDirectConnect(server, placement, protocol);
            return;
        }

        const renderer = overrideRenderer || (protocol && getRendererForProtocol(protocol)) || server.renderer;
        initiateConnection({ server: { ...server, renderer }, identity, placement, protocol });
    };

    const connectFromDrop = (serverId, placement) => {
        const server = getServerById(serverId);
        if (!server) return;
        connectToServer(server.id, server.identities?.[0], undefined, placement);
    };

    useEffect(() => {
        const liveIds = new Set(liveSessions.map(session => session.id));
        const staleIds = new Set(activeSessions
            .filter(s => s.isJoined && !liveIds.has(s.joinSessionId))
            .map(s => s.id));
        if (!staleIds.size) return;

        const remaining = activeSessions.filter(s => !staleIds.has(s.id));
        setActiveSessions(remaining);
        setActiveSessionId(current => staleIds.has(current) ? remaining.at(-1)?.id || null : current);
    }, [liveSessions, activeSessions, setActiveSessions, setActiveSessionId]);

    const joinLiveSession = (liveSession) => {
        const tabId = `join-${liveSession.id}`;

        setActiveSessions(prevSessions => {
            if (prevSessions.some(s => s.id === tabId)) return prevSessions;
            return [...prevSessions, {
                id: tabId,
                joinSessionId: liveSession.id,
                isJoined: true,
                writable: liveSession.writable,
                owner: liveSession.owner,
                server: {
                    id: liveSession.entryId,
                    name: liveSession.entryName,
                    icon: liveSession.icon,
                    type: liveSession.protocol,
                    renderer: liveSession.renderer,
                },
                type: liveSession.type || undefined,
                organizationId: liveSession.organizationId,
                organizationName: liveSession.organizationName,
            }];
        });
        setActiveSessionId(tabId);
    };

    /**
     * Opens the file manager. `protocol` may be "sftp" (default), "ftp" or "ftps" on multi-protocol entries.
     */
    const openSFTP = async (server, identity, protocol = "sftp") => {
        initiateConnection({ server: getServerById(server), identity, type: "sftp", protocol: protocol === "sftp" ? null : protocol });
    };

    const openBrowser = async (server, identity) => {
        initiateConnection({ server: getServerById(server), identity, type: "web" });
    };

    const performConnection = async (options, connectionReason = null) => {
        const { server, identity = null, type = null, protocol = null, directIdentity = null, scriptId = null, scriptName = null, placement = null, replaceSessionId = null } = options;
        try {
            // `type` is the legacy renderer override ("sftp" / "web"); `protocol` selects one of the
            // entry's enabled protocols. The API accepts either in its `type` field.
            const payload = {
                entryId: server.id,
                identityId: identity?.id,
                connectionReason,
                type: protocol || type,
                tabId: getTabId(),
                browserId: getBrowserId(),
            };

            if (directIdentity) payload.directIdentity = directIdentity;
            if (scriptId) payload.scriptId = scriptId;
            const session = await postRequest("/connections", payload);

            const organization = findOrganizationForServer(server.id, servers);
            const organizationId = organization ? parseInt(organization.id.split("-")[1]) : null;

            const replacedSession = replaceSessionId ? activeSessions.find(s => s.id === replaceSessionId) : null;
            const reconnectKey = replacedSession?.reconnectKey || makeReconnectKey();

            const sessionData = {
                server,
                identity: identity?.id,
                id: session.sessionId,
                type: type || getSessionTypeForProtocol(protocol) || undefined,
                protocol: protocol || (type === "web" ? "web" : type === "sftp" ? "sftp" : getPrimaryProtocol(server)) || undefined,
                organizationId: organizationId,
                organizationName: organization?.name || null,
                scriptId: scriptId || undefined,
                scriptName: scriptName || undefined,
                reconnectKey,
            };

            if (replaceSessionId) {
                const groupId = replacedSession?.groupId ?? null;
                closingSessionsRef.current.add(replaceSessionId);
                erroredSessionsRef.current.delete(replaceSessionId);
                reconnectReplacementsRef.current.set(session.sessionId, replaceSessionId);

                let rejoinGroup = Promise.resolve();
                if (groupId) {
                    // Keep the reconnected session in its split-screen group: take over the
                    // old session's pane and re-join the group server-side before the old
                    // session is deleted (an emptied group would otherwise be pruned).
                    sessionData.groupId = groupId;
                    pendingGroupAssignmentsRef.current.set(session.sessionId, groupId);
                    sessionLayout.replaceSession(groupId, replaceSessionId, session.sessionId);
                    rejoinGroup = patchRequest(`/connections/${session.sessionId}/group`, { groupId })
                        .catch(error => {
                            console.debug("Failed to re-join session group after reconnect:", error);
                            setActiveSessions(prev => prev.map(s => s.id === session.sessionId ? { ...s, groupId: null } : s));
                        })
                        .finally(() => pendingGroupAssignmentsRef.current.delete(session.sessionId));
                }
                rejoinGroup.then(() => deleteRequest(`/connections/${replaceSessionId}`).catch(error => {
                    console.debug("Old session deletion request failed:", error);
                }));

                setActiveSessions(prevSessions => {
                    const withoutNew = prevSessions.filter(s => s.id !== session.sessionId);
                    const idx = withoutNew.findIndex(s => s.id === replaceSessionId);
                    if (idx === -1) return [...withoutNew, sessionData];
                    const next = [...withoutNew];
                    next.splice(idx, 1, sessionData);
                    return next;
                });
            } else {
                sessionLayout.placeSession(session.sessionId, placement);
                setActiveSessions(prevSessions => [...prevSessions, sessionData]);
            }
            setActiveSessionId(session.sessionId);
        } catch (error) {
            console.error("Failed to create session", error);
        }
    };

    const initiateConnection = (options) => {
        if (!options.server) return;

        const requiresReason = checkConnectionReasonRequired(options.server.id, servers);
        if (requiresReason) {
            setPendingConnection(options);
            setConnectionReasonDialogOpen(true);
            return;
        }

        void performConnection(options);
    };

    const runScript = async (serverId, identityId, scriptId) => {
        const server = getServerById(serverId);
        if (!server) {
            console.error("Server not found");
            return;
        }

        initiateConnection({ server, identity: { id: identityId }, scriptId });
    };

    const resumeConnection = async (sessionId) => {
        try {
            await postRequest(`/connections/${sessionId}/resume`, {
                tabId: getTabId(),
                browserId: getBrowserId(),
            });
            setActiveSessionId(sessionId);
        } catch (error) {
            console.error("Failed to resume session", error);
        }
    };

    const handleConnectionReasonProvided = (reason) => {
        if (pendingConnection) {
            void performConnection(pendingConnection, reason);
            setPendingConnection(null);
        }
        setConnectionReasonDialogOpen(false);
    };

    const handleConnectionReasonCanceled = () => {
        setPendingConnection(null);
        setConnectionReasonDialogOpen(false);
    };

    const disconnectFromServer = useCallback((sessionId) => {
        erroredSessionsRef.current.delete(sessionId);
        setActiveSessions(prev => {
            const newSessions = prev.filter(session => session.id !== sessionId);
            setActiveSessionId(currentActiveId => {
                if (newSessions.length === 0) return null;
                if (sessionId === currentActiveId) return newSessions.at(-1)?.id || null;
                return currentActiveId;
            });
            return newSessions;
        });
    }, [setActiveSessions, setActiveSessionId]);

    const closeSession = (sessionId) => {
        const session = activeSessions.find(s => s.id === sessionId);
        if (session?.type !== "notes" && !session?.isJoined) {
            closingSessionsRef.current.add(sessionId);
            deleteRequest(`/connections/${sessionId}`).catch(error => {
                console.debug("Session deletion request failed:", error);
            });
        }
        disconnectFromServer(sessionId);
    };

    const reconnectSession = (sessionId) => {
        const session = activeSessions.find(s => s.id === sessionId);
        if (!session || session.type === "notes" || session.isJoined) return;

        initiateConnection({
            server: session.server,
            identity: session.identity ? { id: session.identity } : null,
            type: session.type ?? null,
            scriptId: session.scriptId ?? null,
            scriptName: session.scriptName ?? null,
            replaceSessionId: sessionId,
        });
    };

    const autoReconnectApi = useAutoReconnect({
        activeSessions,
        reconnectSession,
        getSessionError,
        enabled: autoReconnect,
        serverConnected: isConnected,
    });
    useEffect(() => {
        autoReconnectRef.current = autoReconnectApi;
    });

    const openNotes = (serverId) => {
        const server = getServerById(serverId);
        if (!server) return;

        const notesId = `notes-${serverId}`;
        const existing = activeSessions.find(s => s.id === notesId);
        if (existing) {
            setActiveSessionId(notesId);
            return;
        }

        const organization = findOrganizationForServer(server.id, servers);
        const organizationId = organization ? parseInt(organization.id.split("-")[1]) : null;

        const sessionData = {
            server,
            id: notesId,
            type: "notes",
            organizationId,
            organizationName: organization?.name || null,
        };

        setActiveSessions(prev => [...prev, sessionData]);
        setActiveSessionId(notesId);
    };

    const hibernateSession = async (sessionId) => {
        try {
            await postRequest(`/connections/${sessionId}/hibernate`);
        } catch (error) {
            console.error("Failed to hibernate session", error);
        }
    };

    const duplicateSession = async (sessionId) => {
        try {
            const result = await postRequest(`/connections/${sessionId}/duplicate`, {
                tabId: getTabId(),
                browserId: getBrowserId(),
            });

            if (result?.sessionId) {
                const originalSession = activeSessions.find(s => s.id === sessionId);
                if (originalSession) {
                    const sessionData = {
                        ...originalSession,
                        id: result.sessionId,
                        shareId: null,
                        shareWritable: false,
                    };
                    setActiveSessions(prevSessions => [...prevSessions, sessionData]);
                    setActiveSessionId(result.sessionId);
                }
            }
        } catch (error) {
            console.error("Failed to duplicate session", error);
        }
    };

    const groupMemberIds = useCallback((groupId, extraId = null, excludeId = null) => {
        const ids = activeSessions
            .filter(s => (s.groupId ?? null) === groupId && s.id !== excludeId)
            .map(s => s.id);
        if (extraId && !ids.includes(extraId)) ids.push(extraId);
        return ids;
    }, [activeSessions]);

    const createGroupFrom = useCallback(async (sessionIds, name = null) => {
        const uniqueIds = [...new Set(sessionIds)].filter(Boolean);
        if (uniqueIds.length < 1) return;
        try {
            const result = await postRequest("/connections/groups", {
                name: name || undefined,
                sessionIds: uniqueIds,
                tabId: getTabId(),
                browserId: getBrowserId(),
            });
            const groupId = result?.groupId;
            if (!groupId) return;
            setSessionGroups(prev => [...prev, { groupId, name: result.name, order: result.order ?? 0, layout: null }]);
            setActiveSessions(prev => prev.map(s => uniqueIds.includes(s.id) ? { ...s, groupId } : s));
            sessionLayout.rebuildGroup(groupId, uniqueIds);
            setActiveSessionId(uniqueIds[0]);
        } catch (error) {
            console.error("Failed to create session group", error);
        }
    }, [sessionLayout, setActiveSessions, setActiveSessionId, setSessionGroups]);

    const moveSessionToGroup = useCallback(async (sessionId, groupId) => {
        const previousGroupId = activeSessions.find(s => s.id === sessionId)?.groupId ?? null;
        if (previousGroupId === groupId) return;
        try {
            await patchRequest(`/connections/${sessionId}/group`, { groupId });
            const targetMembers = groupId ? groupMemberIds(groupId, sessionId) : [];
            const previousMembers = previousGroupId ? groupMemberIds(previousGroupId, null, sessionId) : [];
            setActiveSessions(prev => prev.map(s => s.id === sessionId ? { ...s, groupId } : s));
            if (groupId) sessionLayout.rebuildGroup(groupId, targetMembers);
            if (previousGroupId) sessionLayout.rebuildGroup(previousGroupId, previousMembers);
            setActiveSessionId(sessionId);
        } catch (error) {
            console.error("Failed to move session to group", error);
        }
    }, [activeSessions, groupMemberIds, sessionLayout, setActiveSessions, setActiveSessionId]);

    const renameGroup = useCallback(async (groupId, name) => {
        setSessionGroups(prev => prev.map(g => g.groupId === groupId ? { ...g, name } : g));
        try {
            await patchRequest(`/connections/groups/${groupId}`, { name });
        } catch (error) {
            console.error("Failed to rename group", error);
        }
    }, [setSessionGroups]);

    const dissolveGroup = useCallback(async (groupId) => {
        setSessionGroups(prev => prev.filter(g => g.groupId !== groupId));
        setActiveSessions(prev => prev.map(s => (s.groupId ?? null) === groupId ? { ...s, groupId: null } : s));
        sessionLayout.removeGroupState(groupId);
        try {
            await deleteRequest(`/connections/groups/${groupId}`);
        } catch (error) {
            console.error("Failed to dissolve group", error);
        }
    }, [sessionLayout, setActiveSessions, setSessionGroups]);

    const openTerminalFromFileManager = async (sessionId, path) => {
        try {
            const originalSession = activeSessions.find(s => s.id === sessionId);
            if (!originalSession) {
                console.error("Original session not found");
                return;
            }

            const payload = {
                entryId: originalSession.server.id,
                identityId: originalSession.identity,
                type: "terminal",
                startPath: path,
                tabId: getTabId(),
                browserId: getBrowserId(),
            };

            const session = await postRequest("/connections", payload);

            const sessionData = {
                server: { ...originalSession.server, renderer: "terminal" },
                identity: originalSession.identity,
                id: session.sessionId,
                type: "terminal",
                organizationId: originalSession.organizationId,
                organizationName: originalSession.organizationName,
            };

            setActiveSessions(prevSessions => [...prevSessions, sessionData]);
            setActiveSessionId(session.sessionId);
        } catch (error) {
            console.error("Failed to open terminal from file manager", error);
        }
    };

    const closeDialog = () => {
        setServerDialogOpen(false);
        setServerDialogProtocol(null);
        setCurrentFolderId(null);
        setEditServerId(null);
    };

    const closePVEDialog = () => {
        setProxmoxDialogOpen(false);
        setCurrentFolderId(null);
        setEditServerId(null);
    };

    const closeEntryImportDialog = () => {
        setEntryImportDialogOpen(false);
        setCurrentFolderId(null);
        setCurrentOrganizationId(null);
    };

    /** Downloads the entries of a folder / organization (or everything) as a JSON document. */
    const exportEntries = async (scope = {}) => {
        try {
            const params = new URLSearchParams();
            if (scope.folderId) params.set("folderId", scope.folderId);
            if (scope.organizationId) params.set("organizationId", scope.organizationId);
            const query = params.toString();
            const document_ = await getRequest("entries/export" + (query ? `?${query}` : ""));

            const blob = new Blob([JSON.stringify(document_, null, 4)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `nexterm-entries-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Failed to export entries", error);
        }
    };

    const closeSSHConfigImportDialog = () => {
        setSSHConfigImportDialogOpen(false);
        setCurrentFolderId(null);
    };

    const openDirectConnect = (server, placement = null, protocol = null) => {
        if (!requiresIdentity(server, protocol)) {
            const renderer = (protocol && getRendererForProtocol(protocol)) || server.renderer;
            initiateConnection({ server: { ...server, renderer }, placement, protocol });
            return;
        }

        setDirectConnectServer(server);
        setDirectConnectPlacement(placement);
        setDirectConnectProtocol(protocol);
        setDirectConnectDialogOpen(true);
    };

    const openPortForward = async (server) => {
        if (!isTauri()) return;
        try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("open_tunnel_window", { 
                entryId: server.id,
                entryName: server.name 
            });
        } catch (error) {
            console.error("Failed to open port forward window", error);
        }
    };

    const closeDirectConnectDialog = () => {
        setDirectConnectDialogOpen(false);
        setDirectConnectServer(null);
        setDirectConnectPlacement(null);
        setDirectConnectProtocol(null);
    };

    const handleDirectConnect = (directIdentity, protocol = null) => {
        const server = directConnectServer;
        const renderer = (protocol && getRendererForProtocol(protocol)) || server?.renderer;
        initiateConnection({ server: { ...server, renderer }, directIdentity, placement: directConnectPlacement, protocol });
    };

    useEffect(() => {
        if (!servers) return;

        const params = new URLSearchParams(location.search);
        const connectId = params.get("connectId");

        if (connectId) {
            navigate("/servers", { replace: true });

            const handleAutoConnect = async () => {
                const server = getServerById(connectId);

                if (server && canConnectWithoutPrompt(server)) {
                    initiateConnection({ server, identity: server.identities?.[0] ?? null });
                }
            };

            handleAutoConnect();
        }
    }, [servers, location.search]);

    return (
        <div className="server-page">
            <ServerDialog open={serverDialogOpen} onClose={closeDialog} currentFolderId={currentFolderId}
                          currentOrganizationId={currentOrganizationId} editServerId={editServerId}
                          initialProtocol={serverDialogProtocol} />
            <ProxmoxDialog open={proxmoxDialogOpen} onClose={closePVEDialog}
                           currentFolderId={currentFolderId}
                           currentOrganizationId={currentOrganizationId}
                           editServerId={editServerId} />
            <EntryImportDialog open={entryImportDialogOpen} onClose={closeEntryImportDialog}
                               currentFolderId={currentFolderId} currentOrganizationId={currentOrganizationId} />

            <SSHConfigImportDialog open={sshConfigImportDialogOpen} onClose={closeSSHConfigImportDialog}
                                   currentFolderId={currentFolderId}
                                   currentOrganizationId={currentOrganizationId} />
            <DirectConnectDialog
                open={directConnectDialogOpen}
                onClose={closeDirectConnectDialog}
                server={directConnectServer}
                initialProtocol={directConnectProtocol}
                onConnect={handleDirectConnect}
            />
            <ConnectionReasonDialog
                isOpen={connectionReasonDialogOpen}
                onClose={handleConnectionReasonCanceled}
                onConnect={handleConnectionReasonProvided}
                serverName={pendingConnection?.server?.name || "Unknown Server"}
            />
            {leftPaneSlot && createPortal(
                <ServerList setServerDialogOpen={(protocol = null) => {
                    setServerDialogProtocol(protocol);
                    setServerDialogOpen(true);
                }}
                            connectToServer={connectToServer}
                            setProxmoxDialogOpen={() => setProxmoxDialogOpen(true)}
                            setSSHConfigImportDialogOpen={() => setSSHConfigImportDialogOpen(true)}
                            setEntryImportDialogOpen={() => setEntryImportDialogOpen(true)}
                            exportEntries={exportEntries}
                            setCurrentFolderId={setCurrentFolderId} setCurrentOrganizationId={setCurrentOrganizationId}
                            setEditServerId={setEditServerId} openSFTP={openSFTP} openBrowser={openBrowser}
                            hibernatedSessions={hibernatedSessions} resumeSession={resumeConnection}
                            joinLiveSession={joinLiveSession}
                            openDirectConnect={openDirectConnect} runScript={runScript}
                            openNotes={openNotes}
                            openPortForward={isTauri() ? openPortForward : undefined}
                            mobileOpen={mobileServerListOpen} setMobileOpen={setMobileServerListOpen} />,
                leftPaneSlot
            )}
            {visibleSessions.length === 0 && 
                <WelcomePanel 
                    connectToServer={connectToServer} 
                    hibernatedSessions={hibernatedSessions} 
                    resumeSession={resumeConnection}
                    openSFTP={openSFTP}
                    openBrowser={openBrowser}
                    openDirectConnect={openDirectConnect}
                />
            }
            {visibleSessions.length > 0 &&
                <ViewContainer activeSessions={visibleSessions} disconnectFromServer={disconnectFromServer}
                               closeSession={closeSession} reconnectSession={reconnectSession}
                               reconnectReplacements={reconnectReplacementsRef}
                               activeSessionId={activeSessionId} setActiveSessionId={setActiveSessionId}
                               hibernateSession={hibernateSession} duplicateSession={duplicateSession}
                               openNotes={openNotes}
                               markSessionErrored={markSessionErrored}
                               getSessionError={getSessionError}
                               markSessionConnected={autoReconnectApi.markSessionConnected}
                               reconnectNow={autoReconnectApi.reconnectNow}
                               reconnectStates={autoReconnectApi.reconnectStates}
                               setOpenFileEditors={setOpenFileEditors}
                               openTerminalFromFileManager={openTerminalFromFileManager}
                               sessionLayout={sessionLayout}
                               activeGroupId={activeGroupId}
                               sessionGroups={sessionGroups}
                               createGroupFrom={createGroupFrom}
                               moveSessionToGroup={moveSessionToGroup}
                               renameGroup={renameGroup}
                               dissolveGroup={dissolveGroup}
                               connectFromDrop={connectFromDrop} />}
            {openFileEditors.map((editor, index) => (
                editor.type === "preview" ? (
                    <FilePreviewWindow
                        key={editor.id}
                        file={editor.file}
                        session={editor.session}
                        onClose={() => setOpenFileEditors(prev => prev.filter(e => e.id !== editor.id))}
                    />
                ) : (
                    <FileEditorWindow
                        key={editor.id}
                        file={editor.file}
                        session={editor.session}
                        onClose={() => setOpenFileEditors(prev => prev.filter(e => e.id !== editor.id))}
                    />
                )
            ))}
        </div>
    );
};
