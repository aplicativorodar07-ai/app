const socket = io();
const peers = new Map();
let localStream = null;
const FIXED_ROOM = 'sala-principal';
let room = null;
let myName = null;
let isTalking = false;
let allMuted = false;
let isAdmin = false;
let forcedMute = false;
const mutedPeers = new Set();

const statusEl = document.getElementById('status');
const callStatusEl = document.getElementById('callStatus');
const talkBtn = document.getElementById('talk');
const peersEl = document.getElementById('peers');
const entryEl = document.getElementById('entry');
const callEl = document.getElementById('call');
const leaveBtn = document.getElementById('leaveBtn');
const muteAllBtn = document.getElementById('muteAllBtn');
const adminBadge = document.getElementById('adminBadge');
const passwordInput = document.getElementById('passwordInput');
const logEl = document.getElementById('log');
const roomNameEl = document.getElementById('roomName');

if (roomNameEl) roomNameEl.textContent = FIXED_ROOM;

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: '069948666b18c1f742d50ff2',
      credential: '8kWfsG+EEKAkUSlw'
    },
    {
      urls: 'turn:global.relay.metered.ca:80?transport=tcp',
      username: '069948666b18c1f742d50ff2',
      credential: '8kWfsG+EEKAkUSlw'
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: '069948666b18c1f742d50ff2',
      credential: '8kWfsG+EEKAkUSlw'
    },
    {
      urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: '069948666b18c1f742d50ff2',
      credential: '8kWfsG+EEKAkUSlw'
    }
  ],
  iceCandidatePoolSize: 10
};

const AVATAR_COLORS = [
  '#5865f2', '#9b59b6', '#e91e63', '#f39c12',
  '#1abc9c', '#e74c3c', '#3498db', '#2ecc71',
  '#f1c40f', '#e67e22', '#16a085', '#8e44ad'
];

function colorFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function initialsFor(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', !!isError);
}

function setCallStatus(text, isError) {
  if (!callStatusEl) return;
  callStatusEl.textContent = text;
  callStatusEl.classList.toggle('err', !!isError);
}

async function initMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    localStream.getAudioTracks().forEach(t => (t.enabled = false));
    return true;
  } catch (err) {
    setStatus('Erro no microfone: ' + err.message, true);
    return false;
  }
}

function buildPeerRow(id, name, isMe) {
  const el = document.createElement('div');
  el.className = 'peer';
  el.id = 'peer-' + id;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.style.background = 'linear-gradient(145deg, ' + colorFor(name) + ', ' + colorFor(name) + 'cc)';
  avatar.innerHTML = '<span class="ring"></span>' + initialsFor(name);

  const nameEl = document.createElement('span');
  nameEl.className = 'peer-name';
  nameEl.textContent = name;

  el.appendChild(avatar);
  el.appendChild(nameEl);

  if (mutedPeers.has(id)) {
    const muteIcon = document.createElement('span');
    muteIcon.className = 'mute-icon';
    muteIcon.textContent = '🔇';
    el.appendChild(muteIcon);
  }

  if (isMe) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'você';
    el.appendChild(badge);
  } else if (isAdmin) {
    const actions = document.createElement('div');
    actions.className = 'peer-actions';

    const muteBtn = document.createElement('button');
    muteBtn.className = 'icon-btn';
    muteBtn.title = mutedPeers.has(id) ? 'Reativar áudio' : 'Silenciar';
    muteBtn.textContent = mutedPeers.has(id) ? '🔊' : '🔇';
    muteBtn.addEventListener('click', () => {
      socket.emit('admin-mute', { targetId: id, muted: !mutedPeers.has(id) });
    });

    const kickBtn = document.createElement('button');
    kickBtn.className = 'icon-btn danger';
    kickBtn.title = 'Expulsar da sala';
    kickBtn.textContent = '✕';
    kickBtn.addEventListener('click', () => {
      if (confirm('Expulsar ' + name + ' da sala?')) {
        socket.emit('admin-kick', { targetId: id });
      }
    });

    actions.appendChild(muteBtn);
    actions.appendChild(kickBtn);
    el.appendChild(actions);
  }

  return el;
}

function renderPeers() {
  peersEl.innerHTML = '';
  peersEl.appendChild(buildPeerRow('me', myName, true));

  peers.forEach((pc, peerId) => {
    peersEl.appendChild(buildPeerRow(peerId, pc._name || 'Participante', false));
  });
}

function createPeer(peerId, isCaller, name) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  pc._name = name || 'Participante';
  pc._isCaller = isCaller;
  pc._makingOffer = false;
  pc._pendingIce = [];
  peers.set(peerId, pc);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { to: peerId, data: { type: 'ice', candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    let audio = document.getElementById('audio-' + peerId);
    if (!audio) {
      audio = new Audio();
      audio.id = 'audio-' + peerId;
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.autoplay = true;
    audio.muted = allMuted || mutedPeers.has(peerId);
    audio.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };

  if (isCaller) {
    pc.onnegotiationneeded = async () => {
      if (pc._makingOffer) return;
      try {
        pc._makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: offer } });
      } catch (err) {
        console.error('erro ao criar oferta:', err);
      } finally {
        pc._makingOffer = false;
      }
    };
  }

  renderPeers();
  return pc;
}

async function flushPendingIce(pc) {
  if (!pc._pendingIce || !pc._pendingIce.length) return;
  const pending = pc._pendingIce;
  pc._pendingIce = [];
  for (const candidate of pending) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('erro ao aplicar ICE pendente:', err);
    }
  }
}

socket.on('signal', async ({ from, data }) => {
  let pc = peers.get(from);
  if (!pc) pc = createPeer(from, false);

  try {
    if (data.type === 'offer') {
      if (pc._makingOffer) await pc.setLocalDescription({ type: 'rollback' });
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushPendingIce(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });
    }

    if (data.type === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushPendingIce(pc);
    }

    if (data.type === 'ice') {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } else {
        pc._pendingIce.push(data.candidate);
      }
    }
  } catch (err) {
    console.error('erro de sinalização:', err);
  }
});

socket.on('peers-list', (list) => {
  list.forEach(({ peerId, userId, muted }) => {
    if (muted) mutedPeers.add(peerId);
    createPeer(peerId, socket.id > peerId, userId);
  });
  renderPeers();
});

socket.on('peer-joined', ({ peerId, userId }) => {
  createPeer(peerId, socket.id > peerId, userId);
});

socket.on('peer-left', ({ peerId }) => {
  const pc = peers.get(peerId);
  if (pc) pc.close();
  peers.delete(peerId);
  mutedPeers.delete(peerId);
  const audio = document.getElementById('audio-' + peerId);
  if (audio) audio.remove();
  renderPeers();
});

socket.on('peer-talking', ({ peerId, talking }) => {
  const el = document.getElementById('peer-' + peerId);
  if (el) el.classList.toggle('speaking', talking);
});

socket.on('peer-muted', ({ peerId, muted }) => {
  if (muted) mutedPeers.add(peerId);
  else mutedPeers.delete(peerId);

  const audio = document.getElementById('audio-' + peerId);
  if (audio) audio.muted = muted || allMuted;

  renderPeers();
});

socket.on('admin-status', ({ isAdmin: admin }) => {
  isAdmin = admin;
  if (adminBadge) adminBadge.style.display = admin ? 'inline-flex' : 'none';
  renderPeers();
});

socket.on('admin-changed', ({ adminId }) => {
  const isMe = adminId === socket.id;
  if (isMe !== isAdmin) {
    isAdmin = isMe;
    if (adminBadge) adminBadge.style.display = isMe ? 'inline-flex' : 'none';
    renderPeers();
  }
});

socket.on('force-mute', ({ muted }) => {
  forcedMute = muted;
  if (muted && isTalking) setTalking(false);
  if (muted) {
    setCallStatus('Você foi silenciado pelo administrador', true);
  } else {
    setCallStatus('Sala ' + room);
  }
  updateTalkButtonState();
});

socket.on('kicked', () => {
  alert('Você foi removido da sala pelo administrador.');
  socket.emit('leave');
  resetToEntry();
});

socket.on('join-denied', ({ reason }) => {
  setStatus(reason, true);
  if (passwordInput) passwordInput.value = '';
  entryEl.style.display = 'flex';
  callEl.style.display = 'none';
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  room = null;
  myName = null;
});

socket.on('room-count', (n) => {
  if (!room) return;
  if (forcedMute) return;
  setCallStatus('Sala ' + room + ' · ' + n + (n === 1 ? ' pessoa' : ' pessoas'));
});

function addLogEntry(entry) {
  if (!logEl) return;
  const row = document.createElement('div');
  row.className = 'log-row log-' + (entry.type || 'info');

  const time = new Date(entry.time);
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');

  row.innerHTML = '<span class="log-time">' + hh + ':' + mm + '</span><span class="log-text"></span>';
  row.querySelector('.log-text').textContent = entry.text;

  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

socket.on('log-entry', addLogEntry);

socket.on('logs-history', (logs) => {
  if (!logEl) return;
  logEl.innerHTML = '';
  logs.forEach(addLogEntry);
});

function updateTalkButtonState() {
  if (forcedMute) {
    talkBtn.disabled = true;
    talkBtn.textContent = 'Silenciado pelo adm';
    talkBtn.classList.remove('active');
    talkBtn.style.opacity = '0.5';
    talkBtn.style.cursor = 'not-allowed';
  } else {
    talkBtn.disabled = false;
    talkBtn.style.opacity = '';
    talkBtn.style.cursor = '';
    talkBtn.textContent = isTalking ? 'Falando...\nclique para silenciar' : 'Clique para falar';
  }
}

function setTalking(state) {
  if (!localStream) return;
  if (forcedMute && state) return;
  isTalking = state;
  localStream.getAudioTracks().forEach(t => (t.enabled = state));
  socket.emit('talking', { room, talking: state });
  talkBtn.classList.toggle('active', state);
  updateTalkButtonState();
  const me = document.getElementById('peer-me');
  if (me) me.classList.toggle('speaking', state);
}

function toggleTalking() {
  if (forcedMute) return;
  setTalking(!isTalking);
}

talkBtn.addEventListener('click', toggleTalking);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && room && !e.repeat && !forcedMute) {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    toggleTalking();
  }
});

muteAllBtn.addEventListener('click', () => {
  allMuted = !allMuted;
  document.querySelectorAll('audio').forEach(a => {
    const peerId = a.id.replace('audio-', '');
    a.muted = allMuted || mutedPeers.has(peerId);
  });
  muteAllBtn.textContent = allMuted ? 'Reativar áudio' : 'Mutar todos';
  muteAllBtn.style.color = allMuted ? '#ff8a8d' : '';
});

document.getElementById('enterBtn').addEventListener('click', async () => {
  const nameVal = document.getElementById('nameInput').value.trim();
  const passVal = passwordInput ? passwordInput.value : '';

  if (!nameVal) {
    setStatus('Preencha seu apelido', true);
    return;
  }

  room = FIXED_ROOM;
  myName = nameVal;

  setStatus('Conectando...');
  const ok = await initMic();
  if (!ok) return;

  entryEl.style.display = 'none';
  callEl.style.display = 'flex';
  setCallStatus('Sala ' + room);

  socket.emit('join', { room, userId: myName, password: passVal });
  renderPeers();
});

function resetToEntry() {
  isTalking = false;
  allMuted = false;
  isAdmin = false;
  forcedMute = false;
  mutedPeers.clear();
  talkBtn.classList.remove('active');
  talkBtn.disabled = false;
  talkBtn.style.opacity = '';
  talkBtn.style.cursor = '';
  talkBtn.textContent = 'Clique para falar';
  muteAllBtn.textContent = 'Mutar todos';
  muteAllBtn.style.color = '';
  if (adminBadge) adminBadge.style.display = 'none';
  if (logEl) logEl.innerHTML = '';
  peers.forEach(pc => pc.close());
  peers.clear();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  document.querySelectorAll('audio').forEach(a => a.remove());
  room = null;
  myName = null;
  callEl.style.display = 'none';
  entryEl.style.display = 'flex';
  setStatus('Preencha e entre');
}

leaveBtn.addEventListener('click', () => {
  socket.emit('leave');
  resetToEntry();
});

socket.on('disconnect', () => {
  if (room) setCallStatus('Conexão perdida. Reconectando...', true);
});

socket.on('connect', () => {
  if (room && myName) {
    const passVal = passwordInput ? passwordInput.value : '';
    socket.emit('join', { room, userId: myName, password: passVal });
    setCallStatus('Reconectado à sala ' + room);
  }
});