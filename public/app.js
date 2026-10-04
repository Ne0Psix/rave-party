let socket;
try {
  socket = io();
} catch (e) {
  console.error("Socket error", e);
}

// 1. КОМНАТА И URL
let roomId = 'party_1';
try {
  const urlParams = new URLSearchParams(window.location.search);
  const pRoom = urlParams.get('room');
  if (pRoom) {
    roomId = pRoom;
  } else {
    roomId = 'room_' + Math.random().toString(36).substring(2, 8);
    if (window.history && window.history.replaceState && window.location.protocol.startsWith('http')) {
      window.history.replaceState(null, '', `?room=${roomId}`);
    }
  }
} catch (err) {}

document.getElementById('room-badge').innerText = `Комната: ${roomId}`;

let myUsername = 'Гость';
let serverTimeDelta = 0;
let isRemoteAction = false;
let currentEngine = 'html5'; // 'html5' | 'hls' | 'youtube' | 'stream'
let hlsInstance = null;
let ytPlayer = null;
let ytReady = false;

// DOM элементы
const video = document.getElementById('main-video');
const ytBox = document.getElementById('yt-player-box');
const streamVideo = document.getElementById('stream-video');
const unlockModal = document.getElementById('unlock-modal');
const usernameInput = document.getElementById('username-input');
const btnEnter = document.getElementById('btn-enter');
const playerControls = document.getElementById('player-controls');
const playerTapZone = document.getElementById('player-tap-zone');
const seekBar = document.getElementById('seek-bar');
const seekFill = document.getElementById('seek-fill');
const timeDisplay = document.getElementById('time-display');
const btnPlayPause = document.getElementById('btn-play-pause');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');

// --- РЕШЕНИЕ ПРОБЛЕМЫ: ПОЛЕ ВВОДА НЕ УХОДИТ ПОД КЛАВИАТУРУ ---
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    document.getElementById('app-root').style.height = `${window.visualViewport.height}px`;
    const scroller = document.getElementById('chat-scroller');
    scroller.scrollTop = scroller.scrollHeight;
  });
}

// --- ВХОД В КОМНАТУ ---
btnEnter.addEventListener('click', () => {
  myUsername = usernameInput.value.trim() || ('Участник_' + Math.floor(Math.random() * 900 + 100));
  unlockModal.style.display = 'none';

  // Разблокировка медиа-контекста iOS
  try {
    video.play().then(() => video.pause()).catch(() => {});
  } catch (e) {}

  if (socket) {
    if (socket.connected) socket.emit('join_room', { roomId, username: myUsername });
    else socket.on('connect', () => socket.emit('join_room', { roomId, username: myUsername }));
  }
  showToast(`Вы вошли как ${myUsername}`);
});

usernameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnEnter.click();
});

// Скопировать ссылку
document.getElementById('btn-copy-invite').addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href)
    .then(() => showToast('Ссылка скопирована!'))
    .catch(() => prompt('Скопируйте ссылку:', window.location.href));
});

function showToast(text) {
  const toast = document.getElementById('toast');
  toast.innerText = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// --- УНИВЕРСАЛЬНЫЙ ДВИЖОК ПЛЕЕРА (YOUTUBE / HLS / MP4) ---

// Проверка типа медиа по ссылке
function detectMediaType(url) {
  if (!url) return 'html5';
  if (url.includes('youtube.com/') || url.includes('youtu.be/')) return 'youtube';
  if (url.includes('.m3u8')) return 'hls';
  return 'html5';
}

function extractYouTubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? match[1] : null;
}

// Инициализация YouTube IFrame API
window.onYouTubeIframeAPIReady = function() {
  ytPlayer = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1
    },
    events: {
      onReady: () => { ytReady = true; },
      onStateChange: onYouTubeStateChange
    }
  });
};

function onYouTubeStateChange(event) {
  if (isRemoteAction || currentEngine !== 'youtube') return;
  if (event.data === YT.PlayerState.PLAYING) emitPlayerAction(true);
  else if (event.data === YT.PlayerState.PAUSED) emitPlayerAction(false);
}

// Переключение видеоисточника
function loadMediaSource(url) {
  const type = detectMediaType(url);
  currentEngine = type;

  // Очистка старых источников
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.pause();
  video.style.display = 'none';
  ytBox.style.display = 'none';
  streamVideo.style.display = 'none';

  if (type === 'youtube') {
    ytBox.style.display = 'block';
    const ytid = extractYouTubeId(url);
    if (ytid) {
      if (ytReady && ytPlayer && ytPlayer.loadVideoById) {
        ytPlayer.loadVideoById(ytid);
      } else {
        setTimeout(() => loadMediaSource(url), 500);
      }
    } else {
      showToast('Неверная ссылка YouTube');
    }
  } else if (type === 'hls') {
    video.style.display = 'block';
    if (Hls.isSupported()) {
      hlsInstance = new Hls();
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url; // Safari iOS нативно поддерживает HLS
    }
    video.play().catch(() => {});
  } else {
    video.style.display = 'block';
    video.src = url;
    video.play().catch(() => {});
  }
}

// --- УПРАВЛЕНИЕ ВОСПРОИЗВЕДЕНИЕМ (PLAY / PAUSE / SEEK) ---
function getPlayerCurrentTime() {
  if (currentEngine === 'youtube' && ytReady && ytPlayer.getCurrentTime) {
    return ytPlayer.getCurrentTime() || 0;
  }
  return video.currentTime || 0;
}

function getPlayerDuration() {
  if (currentEngine === 'youtube' && ytReady && ytPlayer.getDuration) {
    return ytPlayer.getDuration() || 0;
  }
  return video.duration || 0;
}

function setPlayerTime(time) {
  if (currentEngine === 'youtube' && ytReady && ytPlayer.seekTo) {
    ytPlayer.seekTo(time, true);
  } else {
    video.currentTime = time;
  }
}

function setPlayerState(play) {
  if (currentEngine === 'youtube' && ytReady) {
    if (play) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
  } else {
    if (play) video.play().catch(() => {}); else video.pause();
  }
}

function emitPlayerAction(forceIsPlaying) {
  if (isRemoteAction || !socket) return;
  const isPlaying = forceIsPlaying !== undefined ? forceIsPlaying : (
    currentEngine === 'youtube' ? (ytPlayer && ytPlayer.getPlayerState() === 1) : !video.paused
  );
  socket.emit('player_action', {
    currentTime: getPlayerCurrentTime(),
    isPlaying: isPlaying
  });
}

btnPlayPause.addEventListener('click', () => {
  const isCurrentlyPlaying = currentEngine === 'youtube' 
    ? (ytPlayer && ytPlayer.getPlayerState() === 1) 
    : !video.paused;

  setPlayerState(!isCurrentlyPlaying);
  emitPlayerAction(!isCurrentlyPlaying);
});

video.addEventListener('play', () => {
  iconPlay.style.display = 'none';
  iconPause.style.display = 'block';
  emitPlayerAction(true);
});
video.addEventListener('pause', () => {
  iconPlay.style.display = 'block';
  iconPause.style.display = 'none';
  emitPlayerAction(false);
});

document.getElementById('btn-backward').addEventListener('click', () => {
  setPlayerTime(Math.max(0, getPlayerCurrentTime() - 10));
  emitPlayerAction();
});
document.getElementById('btn-forward').addEventListener('click', () => {
  setPlayerTime(Math.min(getPlayerDuration(), getPlayerCurrentTime() + 10));
  emitPlayerAction();
});

// Таймлайн бар
setInterval(() => {
  const cur = getPlayerCurrentTime();
  const dur = getPlayerDuration();
  if (dur > 0) {
    seekFill.style.width = (cur / dur * 100) + '%';
    timeDisplay.innerText = `${formatTime(cur)} / ${formatTime(dur)}`;
  }
}, 300);

seekBar.addEventListener('click', e => {
  const dur = getPlayerDuration();
  if (dur <= 0) return;
  const rect = seekBar.getBoundingClientRect();
  const perc = (e.clientX - rect.left) / rect.width;
  setPlayerTime(perc * dur);
  emitPlayerAction();
});

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// --- УМНОЕ СКРЫТИЕ ПАНЕЛИ УПРАВЛЕНИЯ ПЛЕЕРОМ ---
let controlsTimeout;
function showControls() {
  playerControls.classList.remove('hidden');
  clearTimeout(controlsTimeout);
  controlsTimeout = setTimeout(() => {
    const isPlaying = currentEngine === 'youtube' 
      ? (ytPlayer && ytPlayer.getPlayerState() === 1) 
      : !video.paused;
    if (isPlaying) playerControls.classList.add('hidden');
  }, 3500);
}

playerTapZone.addEventListener('click', () => {
  if (playerControls.classList.contains('hidden')) showControls();
  else playerControls.classList.add('hidden');
});
playerTapZone.addEventListener('mousemove', showControls);

// --- ГОРИЗОНТАЛЬНЫЙ ПОЛНОЭКРАННЫЙ РЕЖИМ ---
document.getElementById('btn-fullscreen').addEventListener('click', async () => {
  const container = document.getElementById('player-container');

  if (!document.fullscreenElement) {
    if (container.requestFullscreen) {
      await container.requestFullscreen();
    } else if (container.webkitRequestFullscreen) {
      await container.webkitRequestFullscreen();
    }

    // Принудительно разворачиваем экран в горизонтальный режим
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  } else {
    document.exitFullscreen();
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }
  }
});

// --- ДОБАВЛЕНИЕ И СМЕНА ССЫЛОК ---
document.getElementById('btn-play-now').addEventListener('click', () => {
  const url = document.getElementById('media-url-input').value.trim();
  const title = document.getElementById('media-title-input').value.trim() || url;
  if (!url) return showToast('Вставьте ссылку');

  if (socket) socket.emit('change_video_direct', { url, title });
  document.getElementById('media-url-input').value = '';
  document.getElementById('media-title-input').value = '';
  switchTab('chat');
});

document.getElementById('btn-add-queue').addEventListener('click', () => {
  const url = document.getElementById('media-url-input').value.trim();
  const title = document.getElementById('media-title-input').value.trim() || url;
  if (!url) return showToast('Вставьте ссылку');

  if (socket) socket.emit('add_to_queue', { url, title });
  document.getElementById('media-url-input').value = '';
  document.getElementById('media-title-input').value = '';
  showToast('Добавлено в очередь!');
});

// Тестовые чипы
document.querySelectorAll('.sample-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('media-url-input').value = btn.dataset.url;
    document.getElementById('media-title-input').value = btn.dataset.title;
  });
});

// --- СИНХРОНИЗАЦИЯ ЧЕРЕЗ СОКЕТЫ ---
if (socket) {
  socket.on('init_state', ({ roomState, messages }) => {
    if (roomState.mode === 'webrtc_stream' && roomState.broadcasterId) {
      switchToScreenMode();
    } else if (roomState.videoUrl) {
      loadMediaSource(roomState.videoUrl);
      setTimeout(() => {
        setPlayerTime(roomState.currentTime || 0);
        if (roomState.isPlaying) setPlayerState(true);
      }, 800);
    }
    updateQueueUI(roomState.queue || []);
    const scroller = document.getElementById('chat-scroller');
    scroller.innerHTML = '';
    (messages || []).forEach(appendMessageUI);
  });

  socket.on('video_switched', ({ url, title }) => {
    loadMediaSource(url);
    showToast(`Сейчас играет: ${title}`);
  });

  socket.on('sync_player', ({ currentTime, isPlaying }) => {
    isRemoteAction = true;
    const cur = getPlayerCurrentTime();
    if (Math.abs(cur - currentTime) > 1.5) {
      setPlayerTime(currentTime);
    }
    setPlayerState(isPlaying);
    setTimeout(() => { isRemoteAction = false; }, 400);
  });

  socket.on('queue_updated', queue => updateQueueUI(queue));
}

function updateQueueUI(queue) {
  document.getElementById('queue-count').innerText = queue.length;
  const container = document.getElementById('queue-items-container');
  container.innerHTML = '';
  if (queue.length === 0) {
    container.innerHTML = '<div class="empty-state">Очередь воспроизведения пуста</div>';
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
        <button class="btn btn-secondary" onclick="socket.emit('play_queue_item', '${item.id}')">▶</button>
        <button class="btn btn-secondary" onclick="socket.emit('remove_from_queue', '${item.id}')">✕</button>
      </div>
    `;
    container.appendChild(card);
  });
}

document.getElementById('btn-skip-next').addEventListener('click', () => {
  const first = document.querySelector('.queue-card button');
  if (first) first.click();
});

// --- СТРИМ ЭКРАНА (VK, ЛЮБЫЕ САЙТЫ) ---
document.getElementById('btn-screenshare').addEventListener('click', async () => {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, width: 1280, height: 720 },
      audio: true
    });
    video.style.display = 'none';
    ytBox.style.display = 'none';
    streamVideo.style.display = 'block';
    streamVideo.srcObject = screenStream;

    socket.emit('start_screen_stream');
    screenStream.getVideoTracks()[0].onended = () => socket.emit('stop_screen_stream');
    showToast('Трансляция сайта запущена!');
  } catch (err) {
    showToast('Захват экрана отменен');
  }
});

function switchToScreenMode() {
  video.style.display = 'none';
  ytBox.style.display = 'none';
  streamVideo.style.display = 'block';
  showToast('Подключение к стриму экрана...');
}

// --- НАДЕЖНАЯ ЗАПИСЬ ГОЛОСОВЫХ (IOS + ANDROID) ---
let mediaRecorder;
let audioChunks = [];
let voiceTimerInterval;
let voiceSeconds = 0;
const btnVoiceToggle = document.getElementById('btn-voice-toggle');
const voiceBar = document.getElementById('voice-record-bar');
const voiceTimer = document.getElementById('voice-timer');
const btnCancelVoice = document.getElementById('btn-cancel-voice');

btnVoiceToggle.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    // Останавливаем и отправляем
    mediaRecorder.stop();
    finishVoiceUI();
  } else {
    // Начинаем запись
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      
      // Автовыбор поддерживаемого формата
      let mime = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4'; // iOS Safari
      else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';

      mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        if (voiceSeconds >= 1) {
          const blob = new Blob(audioChunks, { type: mime });
          const r = new FileReader();
          r.onload = () => {
            if (socket) socket.emit('chat_send', { fileData: r.result, fileType: 'audio' });
          };
          r.readAsDataURL(blob);
        }
      };

      mediaRecorder.start();
      voiceBar.style.display = 'flex';
      btnVoiceToggle.classList.add('recording');
      voiceSeconds = 0;
      voiceTimer.innerText = '00:00';
      voiceTimerInterval = setInterval(() => {
        voiceSeconds++;
        const m = Math.floor(voiceSeconds / 60);
        const s = voiceSeconds % 60;
        voiceTimer.innerText = `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
      }, 1000);
    } catch (e) {
      showToast('Доступ к микрофону заблокирован');
    }
  }
});

btnCancelVoice.addEventListener('click', () => {
  voiceSeconds = 0;
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  finishVoiceUI();
  showToast('Запись отменена');
});

function finishVoiceUI() {
  clearInterval(voiceTimerInterval);
  voiceBar.style.display = 'none';
  btnVoiceToggle.classList.remove('recording');
}

// --- ЧАТ И ФАЙЛЫ ---
const chatForm = document.getElementById('chat-form');
const chatTextInput = document.getElementById('chat-text-input');
const chatScroller = document.getElementById('chat-scroller');
const fileInput = document.getElementById('file-input');

chatForm.addEventListener('submit', e => {
  e.preventDefault();
  const text = chatTextInput.value.trim();
  if (text && socket) {
    socket.emit('chat_send', { text });
    chatTextInput.value = '';
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file || !socket) return;
  const reader = new FileReader();
  reader.onload = () => {
    let t = 'file';
    if (file.type.startsWith('image/')) t = 'image';
    if (file.type.startsWith('video/')) t = 'video';
    if (file.type.startsWith('audio/')) t = 'audio';
    socket.emit('chat_send', { fileData: reader.result, fileType: t });
    fileInput.value = '';
  };
  reader.readAsDataURL(file);
});

if (socket) {
  socket.on('chat_message', msg => appendMessageUI(msg));
}

function appendMessageUI(msg) {
  const div = document.createElement('div');
  div.className = msg.system ? 'chat-msg system' : 'chat-msg';

  if (msg.system) {
    div.innerText = msg.text;
  } else {
    let media = '';
    if (msg.fileData) {
      if (msg.fileType === 'image') media = `<img src="${msg.fileData}" class="msg-media">`;
      else if (msg.fileType === 'video') media = `<video src="${msg.fileData}" controls class="msg-media"></video>`;
      else if (msg.fileType === 'audio') media = `<audio src="${msg.fileData}" controls style="width:100%; margin-top:6px;"></audio>`;
    }
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-user">${escapeHTML(msg.username)}</span>
        <span class="msg-time">${msg.time}</span>
      </div>
      ${msg.text ? `<div class="msg-text">${escapeHTML(msg.text)}</div>` : ''}
      ${media}
    `;
  }
  chatScroller.appendChild(div);
  chatScroller.scrollTop = chatScroller.scrollHeight;
}

// Табы
function switchTab(name) {
  ['chat', 'queue', 'add'].forEach(k => {
    document.getElementById(`tab-${k}`).classList.toggle('active', k === name);
    document.getElementById(`view-${k}`).classList.toggle('active', k === name);
  });
}
document.getElementById('tab-chat').onclick = () => switchTab('chat');
document.getElementById('tab-queue').onclick = () => switchTab('queue');
document.getElementById('tab-add').onclick = () => switchTab('add');
document.getElementById('btn-toggle-queue').onclick = () => switchTab('queue');

function escapeHTML(s) {
  return String(s).replace(/[&<>'"]/g, t => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[t] || t));
}
