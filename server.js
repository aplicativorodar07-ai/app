const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Mamana1209';
const rooms = new Map();

function logEvent(room, text, type) {
  const state = rooms.get(room);
  if (!state) return;
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    text,
    type: type || 'info',
    time: new Date().toISOString()
  };
  state.logs.push(entry);
  if (state.logs.length > 50) state.logs.shift();
  io.to(room).emit('log-entry', entry);
}

function promoteNextAdmin(room) {
  const state = rooms.get(room);
  if (!state || state.members.size === 0) return;

  const nextId = state.members.keys().next().value;
  const nextName = state.members.get(nextId);
  state.adminId = nextId;

  io.to(room).emit('admin-changed', { adminId: nextId });
  io.to(nextId).emit('admin-status', { isAdmin: true });
  logEvent(room, nextName + ' agora é o administrador', 'admin');
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ room, userId, password }) => {
    if (currentRoom) {
      socket.leave(currentRoom);
      const prev = rooms.get(currentRoom);
      if (prev) {
        prev.members.delete(socket.id);
        prev.muted.delete(socket.id);
        if (prev.members.size === 0) rooms.delete(currentRoom);
        else {
          io.to(currentRoom).emit('room-count', prev.members.size);
          if (prev.adminId === socket.id) promoteNextAdmin(currentRoom);
        }
      }
    }

    currentRoom = room;
    socket.join(room);

    if (!rooms.has(room)) {
      rooms.set(room, { members: new Map(), adminId: null, muted: new Set(), logs: [] });
    }
    const state = rooms.get(room);

    const wantsAdmin = typeof password === 'string' && password.length > 0;
    const passwordOk = wantsAdmin && password === ADMIN_PASSWORD;

    if (wantsAdmin && !passwordOk) {
      socket.emit('join-denied', { reason: 'Senha de administrador incorreta' });
      currentRoom = null;
      socket.leave(room);
      return;
    }

    if (passwordOk) {
      if (state.adminId && state.adminId !== socket.id) {
        io.to(state.adminId).emit('admin-status', { isAdmin: false });
      }
      state.adminId = socket.id;
    } else if (!state.adminId) {
      state.adminId = socket.id;
    }

    const list = [];
    state.members.forEach((name, peerId) => {
      list.push({ peerId, userId: name, muted: state.muted.has(peerId) });
    });

    state.members.set(socket.id, userId);

    socket.emit('peers-list', list);
    socket.emit('logs-history', state.logs);
    socket.emit('admin-status', { isAdmin: state.adminId === socket.id });

    socket.to(room).emit('peer-joined', { peerId: socket.id, userId });
    io.to(room).emit('room-count', state.members.size);
    io.to(room).emit('admin-changed', { adminId: state.adminId });

    logEvent(room, userId + ' entrou na sala', 'join');
    if (passwordOk) logEvent(room, userId + ' entrou como administrador', 'admin');
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('talking', ({ room, talking }) => {
    socket.to(room).emit('peer-talking', { peerId: socket.id, talking });
  });

  socket.on('admin-mute', ({ targetId, muted }) => {
    const state = rooms.get(currentRoom);
    if (!state || state.adminId !== socket.id) return;

    if (muted) state.muted.add(targetId);
    else state.muted.delete(targetId);

    io.to(targetId).emit('force-mute', { muted });
    io.to(currentRoom).emit('peer-muted', { peerId: targetId, muted });

    const targetName = state.members.get(targetId) || 'Participante';
    logEvent(currentRoom, targetName + (muted ? ' foi silenciado' : ' foi reativado'), 'mute');
  });

  socket.on('admin-kick', ({ targetId }) => {
    const state = rooms.get(currentRoom);
    if (!state || state.adminId !== socket.id) return;
    if (targetId === socket.id) return;

    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) return;

    const targetName = state.members.get(targetId) || 'Participante';

    targetSocket.emit('kicked');
    targetSocket.leave(currentRoom);
    state.members.delete(targetId);
    state.muted.delete(targetId);

    io.to(currentRoom).emit('peer-left', { peerId: targetId });
    io.to(currentRoom).emit('room-count', state.members.size);
    logEvent(currentRoom, targetName + ' foi expulso da sala', 'kick');
  });

  socket.on('leave', () => {
    if (!currentRoom) return;
    const state = rooms.get(currentRoom);
    const name = state ? state.members.get(socket.id) : null;

    if (state) {
      state.members.delete(socket.id);
      state.muted.delete(socket.id);
      if (state.members.size === 0) {
        rooms.delete(currentRoom);
      } else {
        if (state.adminId === socket.id) promoteNextAdmin(currentRoom);
        io.to(currentRoom).emit('room-count', state.members.size);
      }
    }
    socket.to(currentRoom).emit('peer-left', { peerId: socket.id });
    if (name && rooms.has(currentRoom)) logEvent(currentRoom, name + ' saiu da sala', 'leave');
    socket.leave(currentRoom);
    currentRoom = null;
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const state = rooms.get(currentRoom);
    const name = state ? state.members.get(socket.id) : null;

    if (state) {
      state.members.delete(socket.id);
      state.muted.delete(socket.id);
      if (state.members.size === 0) {
        rooms.delete(currentRoom);
      } else {
        if (state.adminId === socket.id) promoteNextAdmin(currentRoom);
        io.to(currentRoom).emit('room-count', state.members.size);
      }
    }
    socket.to(currentRoom).emit('peer-left', { peerId: socket.id });
    if (name && rooms.has(currentRoom)) logEvent(currentRoom, name + ' desconectou', 'leave');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Servidor rodando em http://localhost:' + PORT);
  console.log('Senha de admin: ' + ADMIN_PASSWORD);
});