import Icon from "@mdi/react";
import { mdiSleep } from "@mdi/js";
import { getIconPath } from "@/common/utils/iconUtils.js";
import "./styles.sass";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useLiveSessions } from "@/common/contexts/LiveSessionContext.jsx";
import AvatarStack from "@/common/components/AvatarStack";
import { getSessionOwnerLabel } from "@/common/utils/avatar.js";
import { useTranslation } from "react-i18next";
import { useContext, useEffect, useRef, useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { patchRequest } from "@/common/utils/RequestUtil.js";
import { DropIndicator } from "../DropIndicator";
import { getServerProtocols, getPrimaryProtocol, getProtocolIcon, PROTOCOL_LABELS } from "@/common/utils/ProtocolUtil.js";
import Tooltip from "@/common/components/Tooltip";

/**
 * How long the pointer has to rest on an entry before its quick-connect buttons appear. Long enough
 * that they do not flicker while the pointer crosses the list, short enough to feel immediate.
 */
const QUICK_CONNECT_DELAY = 500;

/** "checked just now" / "checked 2 min ago" / "checked 3 h ago" for a status-check timestamp. */
const formatCheckedAgo = (checkedAt, t) => {
    const elapsed = Date.now() - new Date(checkedAt).getTime();
    if (!Number.isFinite(elapsed)) return null;
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return t("servers.reachability.checkedJustNow");
    if (minutes < 60) return t("servers.reachability.checkedMinutesAgo", { count: minutes });
    return t("servers.reachability.checkedHoursAgo", { count: Math.floor(minutes / 60) });
};

export const ServerObject = ({ id, name, position, folderId, organizationId, nestedLevel, icon, type, connectToServer, status, tags = [], hibernatedSessionCount = 0 }) => {
    const { loadServers, getServerById } = useContext(ServerContext);
    const { getLiveSessionsForEntry } = useLiveSessions();
    const { t } = useTranslation();
    const [dropPlacement, setDropPlacement] = useState(null);
    const [quickConnectOpen, setQuickConnectOpen] = useState(false);
    const elementRef = useRef(null);
    const hoverTimerRef = useRef(null);

    const isIntegrationEntry = Boolean(type?.startsWith("pve-"));

    const [{ opacity }, dragRef] = useDrag({
        item: { type: "server", id, folderId, position, isIntegrationEntry },
        type: "server",
        collect: monitor => ({
            opacity: monitor.isDragging() ? 0.5 : 1,
        }),
    });

    const [{ isOver }, dropRef] = useDrop({
        accept: "server",
        canDrop: (item) => item.isIntegrationEntry ? item.folderId === folderId : !isIntegrationEntry,
        hover: (item, monitor) => {
            if (!elementRef.current || item.id === id || !monitor.canDrop()) return;
            
            const hoverBoundingRect = elementRef.current.getBoundingClientRect();
            const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
            const clientOffset = monitor.getClientOffset();
            const hoverClientY = clientOffset.y - hoverBoundingRect.top;

            const placement = hoverClientY < hoverMiddleY ? 'before' : 'after';
            setDropPlacement(placement);
        },
        drop: async (item) => {
            if (item.id === id) return;
            
            try {
                await patchRequest(`entries/${item.id}/reposition`, {
                    targetId: id,
                    placement: dropPlacement || 'after',
                    folderId: folderId,
                    organizationId: organizationId,
                });
                
                loadServers();
            } catch (error) {
                console.error("Failed to reposition entry", error);
            }
            
            setDropPlacement(null);
            return { id };
        },
        collect: (monitor) => ({
            isOver: monitor.isOver() && monitor.canDrop(),
        }),
    });

    const server = getServerById(id);

    const liveSessions = getLiveSessionsForEntry(id);
    const liveSessionOwners = liveSessions.map(session => ({
        ...session.owner,
        sessionId: session.id,
    }));
    const liveSessionsTitle = liveSessions.length
        ? t("servers.liveSessions.activeOn", {
            users: [...new Set(liveSessions.map(s => getSessionOwnerLabel(s, t)))].join(", "),
        })
        : undefined;

    const connect = () => {
        connectToServer(server.id, server.identities?.[0]);
    };

    // Each enabled protocol, default first; the identity is left to the server, which picks the one
    // configured for that protocol (see utils/identityResolver).
    const quickConnectProtocols = server?.type === "server"
        ? (() => {
            const primary = getPrimaryProtocol(server);
            return [primary, ...getServerProtocols(server).filter(p => p !== primary)].filter(Boolean);
        })()
        : [];

    const quickConnect = (event, protocol) => {
        event.stopPropagation();
        setQuickConnectOpen(false);
        connectToServer(server.id, undefined, undefined, null, protocol);
    };

    const startHover = () => {
        if (!quickConnectProtocols.length || hoverTimerRef.current) return;
        hoverTimerRef.current = setTimeout(() => {
            hoverTimerRef.current = null;
            setQuickConnectOpen(true);
        }, QUICK_CONNECT_DELAY);
    };

    const endHover = () => {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
        setQuickConnectOpen(false);
    };

    useEffect(() => () => clearTimeout(hoverTimerRef.current), []);

    const noteLine = server?.showNoteInList
        ? (server?.notes || "").split(/\r?\n/)[0].trim()
        : "";

    // Multi-protocol entries list their protocols (SFTP is implied by SSH and not worth a chip).
    const protocolChips = server?.type === "server"
        ? getServerProtocols(server).filter(p => p !== "sftp" || !getServerProtocols(server).includes("ssh"))
        : [];
    const showProtocolChips = protocolChips.length > 1;

    // Per-protocol reachability from the status checker (null while unknown or when checks are disabled).
    const statusDetails = server?.type === "server" ? server.statusDetails : null;
    const protocolStatus = statusDetails?.protocols || {};
    const checkedLabel = statusDetails?.checkedAt ? formatCheckedAgo(statusDetails.checkedAt, t) : null;
    const protocolTitle = (p) => {
        const label = PROTOCOL_LABELS[p] || p.toUpperCase();
        const state = t(`servers.reachability.${protocolStatus[p] || "unknown"}`);
        return checkedLabel && protocolStatus[p] ? `${label}: ${state} (${checkedLabel})` : `${label}: ${state}`;
    };
    const showStatusDot = Boolean(statusDetails) && !showProtocolChips && (status === "online" || status === "offline");

    return (
        <div 
            className={"server-object"}
            style={{ paddingLeft: `${15 + (nestedLevel * 15)}px`, opacity, position: 'relative' }} 
            data-id={id}
            ref={(node) => {
                elementRef.current = node;
                dragRef(dropRef(node));
            }}
            onDoubleClick={connect}
            onMouseEnter={startHover}
            onMouseLeave={() => { setDropPlacement(null); endHover(); }}>
            <DropIndicator show={isOver && dropPlacement === 'before'} placement="before" />
            <div className={
                type && type.startsWith('pve-') 
                    ? (status === 'offline' || status === 'stopped' ? "pve-icon pve-icon-offline" : "pve-icon")
                    : (status === 'offline' ? "system-icon system-icon-offline" : "system-icon")
            }>
                <Icon path={getIconPath(icon)} />
                {showStatusDot && (
                    <span className={`status-dot status-dot-${status}`}
                          title={`${t(`servers.reachability.${status}`)}${checkedLabel ? ` (${checkedLabel})` : ""}`} />
                )}
            </div>
            <div className="server-text">
                <p className="server-name truncate-text">{name}</p>
                {noteLine && <span className="server-note truncate-text">{noteLine}</span>}
            </div>
            {quickConnectOpen && (
                <div className="quick-connect">
                    {quickConnectProtocols.map(p => (
                        <Tooltip key={p} text={t("servers.quickConnectProtocol", { protocol: PROTOCOL_LABELS[p] || p.toUpperCase() })} delay={250}>
                            <button type="button" className="quick-connect-btn" onClick={(e) => quickConnect(e, p)}
                                    onDoubleClick={(e) => e.stopPropagation()}>
                                <Icon path={getProtocolIcon(p)} />
                            </button>
                        </Tooltip>
                    ))}
                </div>
            )}
            {showProtocolChips && !quickConnectOpen && (
                <div className="protocol-chips">
                    {protocolChips.map(p => (
                        <span key={p} title={protocolTitle(p)}
                              className={`protocol-chip${protocolStatus[p] ? ` protocol-chip-${protocolStatus[p]}` : ""}`}>
                            {PROTOCOL_LABELS[p] || p.toUpperCase()}
                        </span>
                    ))}
                </div>
            )}
            {hibernatedSessionCount > 0 && (
                <div className="hibernation-indicator" title={`${hibernatedSessionCount} hibernated session${hibernatedSessionCount > 1 ? 's' : ''}`}>
                    <Icon path={mdiSleep} />
                    <span>{hibernatedSessionCount}</span>
                </div>
            )}
            <AvatarStack className="live-session-avatars" users={liveSessionOwners} max={2}
                         title={liveSessionsTitle} getKey={owner => owner.sessionId} />
            {tags && tags.length > 0 && (
                <div className="tag-circles">
                    {tags.map(tag => (
                        <div
                            key={tag.id}
                            className="tag-circle"
                            style={{ backgroundColor: tag.color }}
                            title={tag.name}
                        />
                    ))}
                </div>
            )}
            <DropIndicator show={isOver && dropPlacement === 'after'} placement="after" />
        </div>
    );
};