import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import {
    deleteRequest,
    postRequest,
    putRequest,
} from "@/common/utils/RequestUtil.js";
import {
    mdiConnection,
    mdiContentCopy,
    mdiFolderOpen,
    mdiFolderPlus,
    mdiFolderRemove,
    mdiFormTextbox,
    mdiPencil,
    mdiPower,
    mdiServerMinus,
    mdiServerPlus,
    mdiStop,
} from "@mdi/js";
import Icon from "@mdi/react";
import { useContext } from "react";
import ProxmoxLogo from "./assets/proxmox.png";
import "./styles.sass";

export const ContextMenu = ({
    position,
    id,
    type,
    setRenameStateId,
    setServerDialogOpen,
    setCurrentFolderId,
    setEditServerId,
    connectToServer,
    connectToPVEServer,
    setProxmoxDialogOpen,
    openSFTP,
}) => {
    const {
        loadServers,
        getServerById,
        getPVEServerById,
        getPVEContainerById,
    } = useContext(ServerContext);

    const server = id
        ? type === "server-object"
            ? getServerById(id)
            : type === "pve-object"
            ? getPVEServerById(id.split("-")[1])
            : getPVEContainerById(id.split("-")[1], id.split("-")[2])
        : null;

    const createFolder = () => {
        putRequest("folders", {
            name: "New Folder",
            parentId: id === null ? undefined : id,
        }).then(async (result) => {
            await loadServers();
            if (result.id) setRenameStateId(result.id);
        });
    };

    const deleteFolder = () => deleteRequest("folders/" + id).then(loadServers);

    const deleteServer = () => deleteRequest("servers/" + id).then(loadServers);

    const createServer = () => {
        setCurrentFolderId(id);
        setServerDialogOpen();
    };

    const createPVEServer = () => {
        setCurrentFolderId(id);
        setProxmoxDialogOpen();
    };

    const connect = () => {
        if (type === "pve-entry") {
            connectToPVEServer(id.split("-")[1], id.split("-")[2]);
            return;
        }

        connectToServer(server?.id, server?.identities[0]);
    };

    const connectSFTP = () => {
        openSFTP(server?.id, server?.identities[0]);
    };

    const editServer = () => {
        setEditServerId(id);
        setServerDialogOpen();
    };

    const editPVEServer = () => {
        setEditServerId(id);
        setProxmoxDialogOpen();
    };

    const postPVEAction = (type) => {
        const serverType = server?.type === "pve-qemu" ? "qemu" : "lxc";
        postRequest(
            "pve-servers/" +
                serverType +
                "/" +
                id.split("-")[1] +
                "/" +
                server?.id +
                "/" +
                type
        ).then(loadServers);
    };

    const deletePVEServer = () => {
        deleteRequest("pve-servers/" + id.split("-")[1]).then(loadServers);
    };

    const duplicateServer = async () => {
        const server = getServerById(id);
        if (!server) return;

        try {
            const identityPromises = server.identities.map(async (identityId) => {
                const response = await postRequest(`identities/${identityId}/duplicate`);
                return response.id;
            });
            
            const newIdentityIds = await Promise.all(identityPromises);

            const serverCopy = {
                name: `${server.name} (copy)`,
                icon: server.icon,
                ip: server.ip,
                port: server.port,
                protocol: server.protocol,
                folderId: server.folderId,
                identities: newIdentityIds,
            };

            await putRequest("servers", serverCopy);
            await loadServers();
        
        } catch (error) {
            console.error("Failed to duplicate server:", error);
        }
    };

    return (
        <div
            className="context-menu"
            style={{ top: position.y, left: position.x }}
        >
            {type !== "server-object" &&
                type !== "pve-object" &&
                type !== "pve-entry" && (
                    <div className="context-item" onClick={createFolder}>
                        <Icon path={mdiFolderPlus} />
                        <p>Create Folder</p>
                    </div>
                )}
            {type === "folder-object" && (
                <>
                    <div className="context-item" onClick={deleteFolder}>
                        <Icon path={mdiFolderRemove} />
                        <p>Delete Folder</p>
                    </div>
                    <div
                        className="context-item"
                        onClick={() => setRenameStateId(id)}
                    >
                        <Icon path={mdiFormTextbox} />
                        <p>Rename Folder</p>
                    </div>
                    <div className="context-item" onClick={createServer}>
                        <Icon path={mdiServerPlus} />
                        <p>Create Server</p>
                    </div>
                    <div className="context-item" onClick={createPVEServer}>
                        <img src={ProxmoxLogo} alt="Proxmox" />
                        <p>Import PVE</p>
                    </div>
                </>
            )}
            {type === "server-object" && (
                <>
                    {server?.identities?.length !== 0 && (
                        <div className="context-item" onClick={connect}>
                            <Icon path={mdiConnection} />
                            <p>Connect</p>
                        </div>
                    )}

                    {server?.identities?.length !== 0 &&
                        server?.protocol === "ssh" && (
                            <div className="context-item" onClick={connectSFTP}>
                                <Icon path={mdiFolderOpen} />
                                <p>Open SFTP</p>
                            </div>
                        )}

                    <div className="context-item" onClick={editServer}>
                        <Icon path={mdiPencil} />
                        <p>Edit Server</p>
                    </div>

                    <div className="context-item" onClick={duplicateServer}>
                        <Icon path={mdiContentCopy} />
                        <p>Duplicate Server</p>
                    </div>

                    <div className="context-item" onClick={deleteServer}>
                        <Icon path={mdiServerMinus} />
                        <p>Delete Server</p>
                    </div>
                </>
            )}

            {type === "pve-object" && (
                <>
                    <div className="context-item" onClick={editPVEServer}>
                        <Icon path={mdiPencil} />
                        <p>Edit PVE</p>
                    </div>
                    <div className="context-item" onClick={deletePVEServer}>
                        <Icon path={mdiServerMinus} />
                        <p>Delete PVE</p>
                    </div>
                </>
            )}

            {server?.status === "running" && (
                <>
                    <div className="context-item" onClick={connect}>
                        <Icon path={mdiConnection} />
                        <p>Connect</p>
                    </div>
                </>
            )}

            {server?.status === "running" && server.type !== "pve-shell" && (
                <>
                    <div
                        className="context-item"
                        onClick={() => postPVEAction("shutdown")}
                    >
                        <Icon path={mdiPower} />
                        <p>Shutdown</p>
                    </div>

                    <div
                        className="context-item"
                        onClick={() => postPVEAction("stop")}
                    >
                        <Icon path={mdiStop} />
                        <p>Stop</p>
                    </div>
                </>
            )}

            {server?.status === "stopped" && (
                <>
                    <div
                        className="context-item"
                        onClick={() => postPVEAction("start")}
                    >
                        <Icon path={mdiPower} />
                        <p>Start</p>
                    </div>
                </>
            )}
        </div>
    );
};
