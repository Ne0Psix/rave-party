const socket = io();

// --- ПАРАМЕТРЫ URL И КОМНАТЫ ---
const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get('room');
if (!roomId) {
  roomId = 'rave_' + Math.random().toString(36).substring(2, 8);
  window.history.replaceState(null, '', `?room=${roomId}`);
}

document.getElementById('room-badge').innerText = `Комната: ${roomId}`;

let myUsername = 'Гость';
let serverTimeDelta = 0;
let isRemoteAction = false;
let currentMode = 'file'; // 'file' или 'webrtc_stream'

// WebRTC Voice Mesh & Screen Share State
let localStreamVoice = null;
let isMicMuted = true;
const voicePeers = {}; // peerId -> RTCPeerConnection
let screenSenderPeer = null;

// Элементы интерфейса
const video = document.getElementById('main-video');
const streamVideo = document.getElementById('stream-video');
const btnPlayPause = document.getElementById('btn-play-pause');
const seekBar = document.getElementById('seek-bar');
const seekFill = document.getElementById('seek-fill');
const timeDisplay = document.getElementById('time-display');
const unlockModal = document.getElementById('unlock-modal');
const usernameInput = document.getElementById('username-input');
const btnEnter = document.getElementById('btn-enter');
const btnCopyInvite = document.getElementById('btn-copy-invite');
const btnMic = document.getElementById('btn-mic');
const btnScreenShare = document.getElementById('btn-screenshare');

// --- 1. NTP КАЛИБРОВКА (СИНХРОНИЗАЦИЯ ЧАСОВ) ---
function pingServerClock() {
  const sendTime = Date.now();
  socket.emit('sync_ntp', sendTime);
}
socket.on('sync_ntp_response', ({ clientTimestamp, serverTimestamp }) => {
  const now = Date.now();
  const latency = (now - clientTimestamp) / 2;
  serverTimeDelta = serverTimestamp - (now - latency);
});
setInterval(pingServerClock, 8000);
pingServerClock();

// --- 2. ВХОД И РАЗБЛОКИРОВКА iOS SAFARI ---
btnEnter.addEventListener('click', async () => {
  myUsername = usernameInput.value.trim() || 'Пользователь_' + Math.floor(Math.random() * 100);
  
  // Проигрываем и сразу ставим на паузу — обязательный жест разблокировки аудио в iOS Safari
  try {
    await video.play();
    video.pause();
  } catch (e) {
    console.log('Audio unlock pass');
  }

  unlockModal.style.display = 'none';
  socket.emit('join_room', { roomId, username: myUsername });
});

// Скопировать уникальную ссылку
btnCopyInvite.addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href);
  showToast('Ссылка скопирована! Отправьте её друзьям.');
});

function showToast(text) {
  const toast = document.getElementById('toast');
  toast.innerText = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// --- 3. ИНИЦИАЛИЗАЦИЯ И СИНХРОНИЗАЦИЯ ПЛЕЕРА ---
socket.on('init_state', ({ roomState, messages }) => {
  currentMode = roomState.mode;

  if (currentMode === 'webrtc_stream' && roomState.broadcasterId) {
    switchToScreenMode(roomState.broadcasterId);
  } else {
    video.src = roomState.videoUrl;
    video.currentTime = roomState.currentTime;
    if (roomState.isPlaying) video.play().catch(() => {});
  }

  updateQueueUI(roomState.queue);
  messages.forEach(appendMessageUI);
});

// Обработка действий Хоста/Участников
socket.on('sync_player', ({ currentTime, isPlaying, serverTimestamp }) => {
  if (currentMode !== 'file') return;
  isRemoteAction = true;

  const currentServerTime = Date.now() + serverTimeDelta;
  const transitLag = Math.max(0, (currentServerTime - serverTimestamp) / 1000);
  const targetTimeline = isPlaying ? currentTime + transitLag : currentTime;

  const drift = Math.abs(video.currentTime - targetTimeline);

  // Мягкая микро-подстройка скорости без дерганий
  if (drift > 1.5) {
    video.currentTime = targetTimeline;
  } else if (drift > 0.25) {
    video.playbackRate = video.currentTime < targetTimeline ? 1.05 : 0.95;
  } else {
    video.playbackRate = 1.0;
  }

  if (isPlaying && video.paused) {
    video.play().catch(() => {});
  } else if (!isPlaying && !video.paused) {
    video.pause();
  }

  setTimeout(() => { isRemoteAction = false; }, 300);
});

// Отправка действий плеера
function emitPlayerAction() {
  if (isRemoteAction || currentMode !== 'file') return;
  socket.emit('player_action', {
    currentTime: video.currentTime,
    isPlaying: !video.paused
  });
}

btnPlayPause.addEventListener('click', () => {
  if (video.paused) video.play(); else video.pause();
  emitPlayerAction();
});

video.addEventListener('play', () => {
  btnPlayPause.innerText = '⏸';
  emitPlayerAction();
});
video.addEventListener('pause', () => {
  btnPlayPause.innerText = '▶';
  emitPlayerAction();
});
video.addEventListener('seeked', emitPlayerAction);

document.getElementById('btn-backward').addEventListener('click', () => {
  video.currentTime = Math.max(0, video.currentTime - 10);
  emitPlayerAction();
});
document.getElementById('btn-forward').addEventListener('click', () => {
  video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
  emitPlayerAction();
});

// Таймлайн бар
video.addEventListener('timeupdate', () => {
  if (!video.duration) return;
  const perc = (video.currentTime / video.duration) * 100;
  seekFill.style.width = perc + '%';
  timeDisplay.innerText = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
});

seekBar.addEventListener('click', (e) => {
  if (currentMode !== 'file' || !video.duration) return;
  const rect = seekBar.getBoundingClientRect();
  const clickPos = (e.clientX - rect.left) / rect.width;
  video.currentTime = clickPos * video.duration;
  emitPlayerAction();
});

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// Полноэкранный режим
document.getElementById('btn-fullscreen').addEventListener('click', () => {
  const container = document.getElementById('player-container');
  if (!document.fullscreenElement) {
    if (container.requestFullscreen) container.requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // Safari iOS fallback
  } else {
    document.exitFullscreen();
  }
});

// --- 4. ОЧЕРЕДЬ ВОСПРОИЗВЕДЕНИЯ ---
document.getElementById('btn-play-now').addEventListener('click', () => {
  const url = document.getElementById('media-url-input').value.trim();
  const title = document.getElementById('media-title-input').value.trim();
  if (!url) return showToast('Введите URL медиа');

  socket.emit('change_video_direct', { url, title });
  document.getElementById('media-url-input').value = '';
  document.getElementById('media-title-input').value = '';
  switchTab('chat');
});

document.getElementById('btn-add-queue').addEventListener('click', () => {
  const url = document.getElementById('media-url-input').value.trim();
  const title = document.getElementById('media-title-input').value.trim();
  if (!url) return showToast('Введите URL медиа');

  socket.emit('add_to_queue', { url, title });
  document.getElementById('media-url-input').value = '';
  document.getElementById('media-title-input').value = '';
  showToast('Добавлено в очередь!');
});

socket.on('video_switched', ({ url, title, mode }) => {
  currentMode = mode;
  streamVideo.style.display = 'none';
  video.style.display = 'block';

  video.src = url;
  video.play().catch(() => {});
  showToast(`Сейчас играет: ${title}`);
});

socket.on('queue_updated', (queue) => {
  updateQueueUI(queue);
});

function updateQueueUI(queue) {
  document.getElementById('queue-count').innerText = queue.length;
  const container = document.getElementById('queue-items-container');
  container.innerHTML = '';

  if (queue.length === 0) {
    container.innerHTML = '<div class="empty-state">Очередь пуста.</div>';
    return;
  }

  queue.forEach(item => {
    const card = document.createElement('div');
    card.className = 'queue-card';
    card.innerHTML = `
      <div>
        <div class="queue-title">${escapeHTML(item.title)}</div>
        <div class="queue-meta">Добавил: ${escapeHTML(item.addedBy)}</div>
      </div>
      <div>
        <button class="btn btn-primary btn-sm" onclick="playQueueItem('${item.id}')">Включить</button>
        <button class="btn btn-secondary btn-sm" onclick="removeQueueItem('${item.id}')">✕</button>
      </div>
    `;
    container.appendChild(card);
  });
}

window.playQueueItem = (id) => socket.emit('play_queue_item', id);
window.removeQueueItem = (id) => socket.emit('remove_from_queue', id);

document.getElementById('btn-skip-next').addEventListener('click', () => {
  const first = document.querySelector('.queue-card button');
  if (first) first.click();
});

// Автопереход к следующему видео по окончании
video.addEventListener('ended', () => {
  const first = document.querySelector('.queue-card button');
  if (first) first.click();
});

// --- 5. СТРИМ ЭКРАНА / ВКЛАДОК (VK, САЙТЫ, КИНОПОИСК) ЧЕРЕЗ WEBRTC ---
btnScreenShare.addEventListener('click', async () => {
  if (currentMode === 'webrtc_stream') {
    socket.emit('stop_screen_stream');
    return;
  }

  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, width: 1280, height: 720 },
      audio: true // Захватывает звук вкладки браузера
    });

    video.style.display = 'none';
    streamVideo.style.display = 'block';
    streamVideo.srcObject = screenStream;

    currentMode = 'webrtc_stream';
    btnScreenShare.classList.add('active');
    btnScreenShare.innerText = '⏹ Остановить стрим';

    socket.emit('start_screen_stream');

    screenStream.getVideoTracks()[0].onended = () => {
      socket.emit('stop_screen_stream');
    };

    // При подключении новых зрителей транслируем им захваченный поток
    socket.on('peer_joined', async ({ peerId }) => {
      initiateScreenPeerConnection(peerId, screenStream);
    });

  } catch (err) {
    showToast('Захват экрана отменен или не поддерживается');
  }
});

socket.on('screen_stream_started', ({ broadcasterId }) => {
  if (broadcasterId !== socket.id) {
    switchToScreenMode(broadcasterId);
  }
});

socket.on('screen_stream_stopped', ({ fallbackUrl }) => {
  currentMode = 'file';
  streamVideo.style.display = 'none';
  video.style.display = 'block';
  btnScreenShare.classList.remove('active');
  btnScreenShare.innerText = '🖥️ Стрим сайта';
  if (fallbackUrl) video.src = fallbackUrl;
});

function switchToScreenMode(broadcasterId) {
  currentMode = 'webrtc_stream';
  video.style.display = 'none';
  streamVideo.style.display = 'block';
  showToast('Подключение к трансляции сайта...');
}

// --- 6. ГОЛОСОВАЯ СВЯЗЬ WEBRTC MESH ---
const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
};

btnMic.addEventListener('click', async () => {
  if (!localStreamVoice) {
    try {
      localStreamVoice = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      isMicMuted = false;
      btnMic.classList.add('active');
      showToast('Микрофон включен');
    } catch (e) {
      return showToast('Доступ к микрофону заблокирован');
    }
  } else {
    isMicMuted = !isMicMuted;
    localStreamVoice.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
    btnMic.classList.toggle('active', !isMicMuted);
    showToast(isMicMuted ? 'Микрофон выключен' : 'Микрофон включен');
  }
});

socket.on('peer_joined', async ({ peerId }) => {
  // Инициируем голосовое P2P соединение
  const pc = createVoicePeerConnection(peerId);
  if (localStreamVoice) {
    localStreamVoice.getTracks().forEach(t => pc.addTrack(t, localStreamVoice));
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal_relay', { targetPeerId: peerId, signal: pc.localDescription, type: 'voice' });
});

socket.on('signal_relay_received', async ({ senderPeerId, signal, type }) => {
  if (type === 'voice') {
    let pc = voicePeers[senderPeerId];
    if (!pc) {
      pc = createVoicePeerConnection(senderPeerId);
      if (localStreamVoice) {
        localStreamVoice.getTracks().forEach(t => pc.addTrack(t, localStreamVoice));
      }
    }

    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal_relay', { targetPeerId: senderPeerId, signal: pc.localDescription, type: 'voice' });
    } else if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
    } else if (signal.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  // Прием трансляции экрана зрителями
  if (type === 'screen') {
    if (!screenSenderPeer) {
      screenSenderPeer = new RTCPeerConnection(rtcConfig);
      screenSenderPeer.ontrack = (event) => {
        streamVideo.srcObject = event.streams[0];
      };
      screenSenderPeer.onicecandidate = (e) => {
        if (e.candidate) socket.emit('signal_relay', { targetPeerId: senderPeerId, signal: { candidate: e.candidate }, type: 'screen' });
      };
    }

    if (signal.type === 'offer') {
      await screenSenderPeer.setRemoteDescription(new RTCSessionDescription(signal));
      const ans = await screenSenderPeer.createAnswer();
      await screenSenderPeer.setLocalDescription(ans);
      socket.emit('signal_relay', { targetPeerId: senderPeerId, signal: screenSenderPeer.localDescription, type: 'screen' });
    } else if (signal.candidate) {
      await screenSenderPeer.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }
});

function createVoicePeerConnection(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);
  voicePeers[peerId] = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal_relay', { targetPeerId: peerId, signal: { candidate: e.candidate }, type: 'voice' });
  };

  pc.ontrack = (e) => {
    let audioElem = document.getElementById(`audio_${peerId}`);
    if (!audioElem) {
      audioElem = document.createElement('audio');
      audioElem.id = `audio_${peerId}`;
      audioElem.autoplay = true;
      document.getElementById('voice-peers-audio').appendChild(audioElem);
    }
    audioElem.srcObject = e.streams[0];
  };

  return pc;
}

async function initiateScreenPeerConnection(watcherId, stream) {
  const pc = new RTCPeerConnection(rtcConfig);
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal_relay', { targetPeerId: watcherId, signal: { candidate: e.candidate }, type: 'screen' });
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal_relay', { targetPeerId: watcherId, signal: pc.localDescription, type: 'screen' });
}

socket.on('peer_left', ({ peerId }) => {
  if (voicePeers[peerId]) {
    voicePeers[peerId].close();
    delete voicePeers[peerId];
  }
  const aud = document.getElementById(`audio_${peerId}`);
  if (aud) aud.remove();
});

// --- 7. ЧАТ, ПРИКРЕПЛЕНИЕ МЕДИА И ГОЛОСОВЫЕ СООБЩЕНИЯ ---
const chatForm = document.getElementById('chat-form');
const chatTextInput = document.getElementById('chat-text-input');
const chatScroller = document.getElementById('chat-scroller');
const fileInput = document.getElementById('file-input');
const btnVoiceRecord = document.getElementById('btn-voice-record');

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatTextInput.value.trim();
  if (text) {
    socket.emit('chat_send', { text });
    chatTextInput.value = '';
  }
});

// Отправка фото / видео / файлов
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let fileType = 'file';
    if (file.type.startsWith('image/')) fileType = 'image';
    if (file.type.startsWith('video/')) fileType = 'video';
    if (file.type.startsWith('audio/')) fileType = 'audio';

    socket.emit('chat_send', {
      fileData: reader.result,
      fileName: file.name,
      fileType: fileType
    });
    fileInput.value = '';
  };
  reader.readAsDataURL(file);
});

// Запись голосовых сообщений
let mediaRecorder;
let audioChunks = [];

btnVoiceRecord.addEventListener('mousedown', startVoiceRecord);
btnVoiceRecord.addEventListener('touchstart', startVoiceRecord);
btnVoiceRecord.addEventListener('mouseup', stopVoiceRecord);
btnVoiceRecord.addEventListener('touchend', stopVoiceRecord);

async function startVoiceRecord(e) {
  e.preventDefault();
  audioChunks = [];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const r = new FileReader();
      r.onload = () => {
        socket.emit('chat_send', {
          fileData: r.result,
          fileName: 'Голосовое сообщение',
          fileType: 'audio'
        });
      };
      r.readAsDataURL(blob);
    };
    mediaRecorder.start();
    btnVoiceRecord.classList.add('recording');
  } catch (err) {
    showToast('Ошибка микрофона');
  }
}

function stopVoiceRecord(e) {
  e.preventDefault();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    btnVoiceRecord.classList.remove('recording');
  }
}

// Отрисовка сообщений
socket.on('chat_message', (msg) => {
  appendMessageUI(msg);
});

function appendMessageUI(msg) {
  const div = document.createElement('div');
  div.className = msg.system ? 'chat-msg system' : 'chat-msg';
  div.id = `msg_${msg.id}`;

  if (msg.system) {
    div.innerText = msg.text;
  } else {
    let mediaContent = '';
    if (msg.fileData) {
      if (msg.fileType === 'image') {
        mediaContent = `<img src="${msg.fileData}" class="msg-media">`;
      } else if (msg.fileType === 'video') {
        mediaContent = `<video src="${msg.fileData}" controls class="msg-media"></video>`;
      } else if (msg.fileType === 'audio') {
        mediaContent = `<audio src="${msg.fileData}" controls style="width:100%; margin-top:6px;"></audio>`;
      }
    }

    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-user">${escapeHTML(msg.username)}</span>
        <span class="msg-time">${msg.time}</span>
      </div>
      ${msg.text ? `<div class="msg-text">${escapeHTML(msg.text)}</div>` : ''}
      ${mediaContent}
      <div class="reactions-tray" id="react_${msg.id}"></div>
    `;

    // Клик по сообщению открывает быстрый выбор реакции
    div.addEventListener('dblclick', () => {
      socket.emit('add_reaction', { messageId: msg.id, emoji: '❤️' });
    });
  }

  chatScroller.appendChild(div);
  chatScroller.scrollTop = chatScroller.scrollHeight;
  if (msg.reactions) renderReactions(msg.id, msg.reactions);
}

// Быстрые эмодзи
document.querySelectorAll('.emoji-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    chatTextInput.value += btn.innerText;
    chatTextInput.focus();
  });
});

// Реакции на сообщения
socket.on('reaction_updated', ({ messageId, reactions }) => {
  renderReactions(messageId, reactions);
});

function renderReactions(messageId, reactions) {
  const container = document.getElementById(`react_${messageId}`);
  if (!container) return;
  container.innerHTML = '';

  for (const [emoji, users] of Object.entries(reactions)) {
    const pill = document.createElement('span');
    pill.className = `reaction-pill ${users.includes(myUsername) ? 'reacted' : ''}`;
    pill.innerText = `${emoji} ${users.length}`;
    pill.onclick = () => socket.emit('add_reaction', { messageId, emoji });
    container.appendChild(pill);
  }
}

// --- 8. ТАБЫ САЙДБАРА ---
const tabs = {
  chat: { btn: document.getElementById('tab-chat'), view: document.getElementById('view-chat') },
  queue: { btn: document.getElementById('tab-queue'), view: document.getElementById('view-queue') },
  add: { btn: document.getElementById('tab-add'), view: document.getElementById('view-add') }
};

Object.keys(tabs).forEach(k => {
  tabs[k].btn.addEventListener('click', () => switchTab(k));
});

function switchTab(name) {
  Object.keys(tabs).forEach(k => {
    tabs[k].btn.classList.toggle('active', k === name);
    tabs[k].view.classList.toggle('active', k === name);
  });
}

document.getElementById('btn-toggle-queue').addEventListener('click', () => switchTab('queue'));

function escapeHTML(str) {
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag] || tag));
}