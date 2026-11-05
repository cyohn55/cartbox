# Cartbox live link (AAA_PRODUCTION_ROADMAP.md D6): push Blender's selection
# to an open Cartbox editor tab.
#
# Install: Edit > Preferences > Add-ons > Install..., pick this file, enable
# "Cartbox Live Link". In the 3D view's sidebar (N), the Cartbox tab has Start
# link, and Push selection (also on save, if ticked). In the editor's Mesh tab,
# Live link > Connect. Each selected object goes over as a GLB under its name:
# the editor puts it in place of the object of that name, or adds it.
#
# The server is plain Python (no Blender needed for it), a minimal WebSocket
# server on 127.0.0.1 only. Run `python3 cartbox_live_link.py --serve FILE.glb`
# to push one file without Blender (tests use this).

import base64
import hashlib
import json
import os
import socket
import struct
import sys
import tempfile
import threading

bl_info = {
    "name": "Cartbox Live Link",
    "author": "Cartbox",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "3D View > Sidebar > Cartbox",
    "description": "Push the selected objects to an open Cartbox editor tab",
    "category": "Import-Export",
}

PORT = 9877
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def accept_key(key):
    """The Sec-WebSocket-Accept for a client's key (RFC 6455)."""
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


def text_frame(payload):
    """One unmasked text frame, as a server sends."""
    data = payload.encode()
    head = bytearray([0x81])
    if len(data) < 126:
        head.append(len(data))
    elif len(data) < 65536:
        head.append(126)
        head += struct.pack(">H", len(data))
    else:
        head.append(127)
        head += struct.pack(">Q", len(data))
    return bytes(head) + data


def read_frame(conn):
    """One frame from a client (masked): (opcode, payload), or None when it's gone."""
    head = conn.recv(2)
    if len(head) < 2:
        return None
    opcode, length = head[0] & 0x0F, head[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", conn.recv(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", conn.recv(8))[0]
    mask = conn.recv(4) if head[1] & 0x80 else b"\0\0\0\0"
    data = bytearray()
    while len(data) < length:
        chunk = conn.recv(length - len(data))
        if not chunk:
            return None
        data += chunk
    return opcode, bytes(b ^ mask[i % 4] for i, b in enumerate(data))


class LinkServer:
    """Accepts editor tabs and sends each pushed model to all of them."""

    def __init__(self, port=PORT):
        self.port = port
        self.clients = []
        self.lock = threading.Lock()
        self.sock = None

    def start(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", self.port))
        self.sock.listen(4)
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while self.sock:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn):
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = conn.recv(4096)
            if not chunk:
                return
            request += chunk
        key = ""
        for line in request.decode(errors="replace").split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
        conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % accept_key(key)).encode())
        with self.lock:
            self.clients.append(conn)
        try:
            while True:
                frame = read_frame(conn)
                if frame is None or frame[0] == 0x8:
                    break
        except OSError:
            pass
        with self.lock:
            if conn in self.clients:
                self.clients.remove(conn)
        conn.close()

    def push(self, name, glb):
        """Send a model (GLB bytes) under a name to every connected tab; how many got it."""
        frame = text_frame(json.dumps({"type": "mesh", "name": name, "data": base64.b64encode(glb).decode()}))
        sent = 0
        with self.lock:
            for conn in list(self.clients):
                try:
                    conn.sendall(frame)
                    sent += 1
                except OSError:
                    self.clients.remove(conn)
        return sent

    def stop(self):
        sock, self.sock = self.sock, None
        if sock:
            sock.close()
        with self.lock:
            for conn in self.clients:
                conn.close()
            self.clients = []


# --- Blender ---------------------------------------------------------------------------------

try:
    import bpy  # noqa: E402
except ImportError:  # outside Blender: the server alone
    bpy = None

_server = None


def _export_object(obj):
    """One object as a GLB, its transform applied as Blender has it."""
    path = os.path.join(tempfile.gettempdir(), "cartbox-live-%s.glb" % abs(hash(obj.name)))
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True)
    with open(path, "rb") as f:
        return f.read()


def push_selection():
    if _server is None:
        return 0
    selected = list(bpy.context.selected_objects)
    sent = 0
    try:
        for obj in selected:
            if obj.type in {"MESH", "ARMATURE", "EMPTY"}:
                sent += _server.push(obj.name, _export_object(obj))
    finally:
        for obj in selected:
            obj.select_set(True)
    return sent


if bpy is not None:

    class CARTBOX_OT_start(bpy.types.Operator):
        bl_idname = "cartbox.link_start"
        bl_label = "Start link"

        def execute(self, context):
            global _server
            if _server is None:
                _server = LinkServer()
                _server.start()
            self.report({"INFO"}, "Cartbox link on port %d: connect from the editor's Mesh tab" % PORT)
            return {"FINISHED"}

    class CARTBOX_OT_push(bpy.types.Operator):
        bl_idname = "cartbox.link_push"
        bl_label = "Push selection"

        def execute(self, context):
            n = push_selection()
            self.report({"INFO"}, "Sent to %d editor tab(s)" % n if n else "No editor tab connected")
            return {"FINISHED"}

    class CARTBOX_PT_panel(bpy.types.Panel):
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = "Cartbox"
        bl_label = "Live link"

        def draw(self, context):
            self.layout.operator("cartbox.link_start")
            self.layout.operator("cartbox.link_push")
            self.layout.prop(context.scene, "cartbox_push_on_save")

    @bpy.app.handlers.persistent
    def _on_save(_):
        if getattr(bpy.context.scene, "cartbox_push_on_save", False):
            push_selection()

    _classes = (CARTBOX_OT_start, CARTBOX_OT_push, CARTBOX_PT_panel)

    def register():
        for c in _classes:
            bpy.utils.register_class(c)
        bpy.types.Scene.cartbox_push_on_save = bpy.props.BoolProperty(name="Push on save", default=False)
        bpy.app.handlers.save_post.append(_on_save)

    def unregister():
        global _server
        if _server:
            _server.stop()
            _server = None
        bpy.app.handlers.save_post.remove(_on_save)
        del bpy.types.Scene.cartbox_push_on_save
        for c in reversed(_classes):
            bpy.utils.unregister_class(c)


if __name__ == "__main__" and bpy is None:
    # python3 cartbox_live_link.py --serve FILE.glb [--port N] [--name NAME]: push one file to the first tab that connects.
    args = sys.argv[1:]
    path = args[args.index("--serve") + 1]
    port = int(args[args.index("--port") + 1]) if "--port" in args else PORT
    name = args[args.index("--name") + 1] if "--name" in args else os.path.splitext(os.path.basename(path))[0]
    server = LinkServer(port)
    server.start()
    print("ready", flush=True)
    import time

    with open(path, "rb") as f:
        glb = f.read()
    for _ in range(200):
        if server.clients:
            time.sleep(0.05)
            server.push(name, glb)
            print("pushed", flush=True)
            time.sleep(0.2)
            break
        time.sleep(0.05)
    server.stop()
