let socket;
try { socket = io(); } catch (e) { console.error("Socket error", e); }

let roomId = 'psix_1';
try {
  const urlParams = new URLSearchParams(window.location.search);
  const p = urlParams.get('room');
  if (p) roomId = p;
  else {
    roomId = 'psix_' + Math.random().toString(36).substring(2, 8);
    if (window.history && window.history.replaceState && location.protocol.startsWith('http')) {
      window.history.replaceState(null, '', `?room=${roomId}`);
    }
  }
} catch (e) {}

document.getElementById('room-badge').innerText = `PsixParty: ${roomId}`;

let myId = null;
let myUsername = localStorage.getItem('psix_username') || '';
let isHost = false;
let currentHostId = null;

// Флаги анти-зацикливания воспроизведения
let isRemoteSync = false;
let syncCooldownTimer = null;
let lastKnownPlayingState = null;

let currentEngine = 'html5';
let hlsInstance = null;
let ytPlayer = null;
let ytReady = false;

// WebRTC Voice
let localVoiceStream = null;
let isMicActive = false;
const voicePeers = {};

// DOM элементы
const video = document.getElementById('main-video');
const ytBox = document.getElementById('yt-player-box');
const ytSyncBadge = document.getElementById('yt-sync-badge');
const gestureLayer = document.getElementById('gesture-layer');
const streamVideo = document.getElementById('stream-video');
const usernameModal = document.getElementById('username-modal');
const usernameInput = document.getElementById('username-input');
const btnSaveUsername = document.getElementById('btn-save-username');
const btnEditUsername = document.getElementById('btn-edit-username');

const playerControls = document.getElementById('player-controls');
const btnPlayPause = document.getElementById('btn-play-pause');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const seekBar = document.getElementById('seek-bar');
const seekFill = document.getElementById('seek-fill');
const seekBuffered = document.getElementById('seek-buffered');
const timeDisplay = document.getElementById('time-display');
const flashBox = document.getElementById('play-state-flash');
const flashPlay = document.getElementById('flash-icon-play');
const flashPause = document.getElementById('flash-icon-pause');

// Настройки
const btnSettings = document.getElementById('btn-settings');
const settingsMenu = document.getElementById('settings-menu');
const selectAudio = document.getElementById('select-audio-track');
const selectSubtitles = document.getElementById('select-subtitle-track');
const selectQuality = document.getElementById('select-quality-track');
const selectSpeed = document.getElementById('select-speed');
const groupAudio = document.getElementById('group-audio-track');
const groupSubtitles = document.getElementById('group-subtitle-track');
const groupQuality = document.getElementById('group-quality-track');
const formatNote = document.getElementById('format-note');

// --- 1. АВТОВХОД ПО НИКНЕЙМУ БЕЗ ПАРОЛЕЙ ---
if (!myUsername) {
  usernameModal.style.display = 'flex';
} else {
  connectUserToRoom(myUsername);
}

btnSaveUsername.onclick = () => {
  const val = usernameInput.value.trim();
  if (!val) return showToast('Введите никнейм');
  myUsername = val;
  localStorage.setItem('psix_username', myUsername);
  usernameModal.style.display = 'none';
  connectUserToRoom(myUsername);
};

btnEditUsername.onclick = () => {
  const newNick = prompt('Введите новый никнейм:', myUsername);
  if (newNick && newNick.trim()) {
    myUsername = newNick.trim();
    localStorage.setItem('psix_username', myUsername);
    location.reload();
  }
};

function connectUserToRoom(nick) {
  try { video.play().then(() => video.pause()).catch(() => {}); } catch (e) {}
  if (socket) {
    if (socket.connected) socket.emit('join_room', { roomId, username: nick });
    else socket.on('connect', () => socket.emit('join_room', { roomId, username: nick }));
  }
}

// Поле ввода не уходит под экран
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    document.getElementById('app-root').style.height = `${window.visualViewport.height}px`;
    const scroller = document.getElementById('chat-scroller');
    scroller.scrollTop = scroller.scrollHeight;
  });
}

document.getElementById('btn-copy-invite').onclick = () => {
  navigator.clipboard.writeText(window.location.href)
    .then(() => showToast('Ссылка скопирована!'))
    .catch(() => prompt('Скопируйте ссылку:', window.location.href));
};

function showToast(text) {
  const toast = document.getElementById('toast');
  toast.innerText = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// --- 2. ПОЛНАЯ ЗАЧИСТКА ПЛЕЕРА ОТ ЗВУКОВ ПРОШЛОГО ВИДЕО ---
function stopAllMedia() {
  // 1. Заглушить и очистить HTML5 видео
  video.pause();
  video.removeAttribute('src');
  video.load();

  // 2. Уничтожить HLS
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  // 3. Остановить YouTube
  if (ytPlayer && ytPlayer.stopVideo) {
    try {
      ytPlayer.stopVideo();
      ytPlayer.clearVideo();
    } catch (e) {}
  }

  // 4. Скрыть контейнеры
  video.style.display = 'none';
  ytBox.style.display = 'none';
  streamVideo.style.display = 'none';
  ytSyncBadge.style.display = 'none';
}

function detectMediaType(url) {
  if (!url) return 'html5';
  if (url.includes('youtube.com/') || url.includes('youtu.be/')) return 'youtube';
  if (url.includes('.m3u8')) return 'hls';
  return 'html5';
}

function extractYouTubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return m ? m[1] : null;
}

window.onYouTubeIframeAPIReady = function() {
  ytPlayer = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onReady: () => { ytReady = true; },
      onStateChange: (e) => {
        // Защита от пинг-понга: реагируем только на физический клик человека, а не на авто-синхронизацию
        if (isRemoteSync || currentEngine !== 'youtube') return;
        if (e.data === YT.PlayerState.PLAYING && lastKnownPlayingState !== true) {
          lastKnownPlayingState = true;
          emitPlayerAction(true);
        } else if (e.data === YT.PlayerState.PAUSED && lastKnownPlayingState !== false) {
          lastKnownPlayingState = false;
          emitPlayerAction(false);
        }
      }
    }
  });
};

function loadMediaSource(url) {
  stopAllMedia(); // Глушим старые звуки

  const type = detectMediaType(url);
  currentEngine = type;
  resetSettingsOptions();

  if (type === 'youtube') {
    ytBox.style.display = 'block';
    ytSyncBadge.style.display = 'flex';
    playerControls.style.display = 'none';
    gestureLayer.style.display = 'none';

    const ytid = extractYouTubeId(url);
    if (ytid) {
      if (ytReady && ytPlayer && ytPlayer.loadVideoById) ytPlayer.loadVideoById(ytid);
      else setTimeout(() => loadMediaSource(url), 500);
    }
  } else {
    playerControls.style.display = 'block';
    gestureLayer.style.display = 'flex';

    if (type === 'hls') {
      video.style.display = 'block';
      groupAudio.style.display = 'flex';
      groupSubtitles.style.display = 'flex';
      groupQuality.style.display = 'flex';
      formatNote.style.display = 'none';

      if (Hls.isSupported()) {
        hlsInstance = new Hls();
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(video);

        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          populateHlsTracks();
          video.play().catch(() => {});
        });
        hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, populateHlsTracks);
        hlsInstance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, populateHlsTracks);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().catch(() => {});
      }
    } else {
      video.style.display = 'block';
      groupAudio.style.display = 'none';
      groupSubtitles.style.display = 'none';
      groupQuality.style.display = 'none';
      formatNote.style.display = 'block';

      video.src = url;
      video.play().catch(() => {});
    }
  }
}

// Воспроизведение локального файла из памяти телефона
document.getElementById('local-video-file').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fileUrl = URL.createObjectURL(file);
  loadMediaSource(fileUrl);
  showToast(`Запущен локальный файл: ${file.name}`);
  switchTab('chat');
};

function resetSettingsOptions() {
  selectAudio.innerHTML = '<option value="-1">Основная / По умолчанию</option>';
  selectSubtitles.innerHTML = '<option value="-1">Отключены</option>';
  selectQuality.innerHTML = '<option value="-1">Автоматически</option>';
}

function populateHlsTracks() {
  if (!hlsInstance) return;

  if (hlsInstance.audioTracks && hlsInstance.audioTracks.length > 1) {
    selectAudio.innerHTML = '';
    hlsInstance.audioTracks.forEach((t, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.innerText = t.name || t.lang || `Озвучка ${i + 1}`;
      if (i === hlsInstance.audioTrack) opt.selected = true;
      selectAudio.appendChild(opt);
    });
  }

  if (hlsInstance.subtitleTracks && hlsInstance.subtitleTracks.length > 0) {
    selectSubtitles.innerHTML = '<option value="-1">Отключены</option>';
    hlsInstance.subtitleTracks.forEach((t, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.innerText = t.name || t.lang || `Субтитры ${i + 1}`;
      if (i === hlsInstance.subtitleTrack) opt.selected = true;
      selectSubtitles.appendChild(opt);
    });
  }

  if (hlsInstance.levels && hlsInstance.levels.length > 1) {
    selectQuality.innerHTML = '<option value="-1">Автоматически</option>';
    hlsInstance.levels.forEach((lvl, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.innerText = `${lvl.height}p (${Math.round(lvl.bitrate / 1000)} kbps)`;
      selectQuality.appendChild(opt);
    });
  }
}

settingsMenu.addEventListener('click', e => e.stopPropagation());

selectAudio.onchange = (e) => {
  if (hlsInstance && hlsInstance.audioTracks) {
    hlsInstance.audioTrack = parseInt(e.target.value);
    showToast(`Озвучка изменена`);
  }
};
selectSubtitles.onchange = (e) => {
  if (hlsInstance) {
    hlsInstance.subtitleTrack = parseInt(e.target.value);
    showToast(`Субтитры изменены`);
  }
};
selectQuality.onchange = (e) => {
  if (hlsInstance) {
    hlsInstance.currentLevel = parseInt(e.target.value);
    showToast(`Качество переключено`);
  }
};
selectSpeed.onchange = (e) => {
  const speed = parseFloat(e.target.value);
  video.playbackRate = speed;
  if (ytPlayer && ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(speed);
  showToast(`Скорость: ${speed}x`);
};

btnSettings.onclick = (e) => {
  e.stopPropagation();
  settingsMenu.classList.toggle('open');
};
document.addEventListener('click', () => settingsMenu.classList.remove('open'));

// --- 3. УСТРАНЕНИЕ ПИНГ-ПОНГА ПАУЗЫ (EVENT LOCK & DEBOUNCE) ---
function markRemoteSync(duration = 1000) {
  isRemoteSync = true;
  clearTimeout(syncCooldownTimer);
  syncCooldownTimer = setTimeout(() => { isRemoteSync = false; }, duration);
}

function getPlayerCurrentTime() {
  if (currentEngine === 'youtube' && ytReady && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime() || 0;
  return video.currentTime || 0;
}
function getPlayerDuration() {
  if (currentEngine === 'youtube' && ytReady && ytPlayer.getDuration) return ytPlayer.getDuration() || 0;
  return video.duration || 0;
}
function setPlayerTime(t) {
  if (currentEngine === 'youtube' && ytReady && ytPlayer.seekTo) ytPlayer.seekTo(t, true);
  else video.currentTime = t;
}

function setPlayerState(play) {
  lastKnownPlayingState = play;
  if (currentEngine === 'youtube' && ytReady) {
    if (play) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
  } else {
    if (play) video.play().catch(() => {}); else video.pause();
  }
  updatePlayButtonUI(play);
}

function updatePlayButtonUI(isPlaying) {
  iconPlay.style.display = isPlaying ? 'none' : 'block';
  iconPause.style.display = isPlaying ? 'block' : 'none';
}

function triggerFlashIcon(isPlaying) {
  flashPlay.style.display = isPlaying ? 'block' : 'none';
  flashPause.style.display = isPlaying ? 'none' : 'block';
  flashBox.classList.add('show');
  setTimeout(() => flashBox.classList.remove('show'), 350);
}

function emitPlayerAction(forceIsPlaying) {
  if (isRemoteSync || !socket) return;
  const isPlaying = forceIsPlaying !== undefined ? forceIsPlaying : (
    currentEngine === 'youtube' ? (ytPlayer && ytPlayer.getPlayerState() === 1) : !video.paused
  );
  lastKnownPlayingState = isPlaying;
  socket.emit('player_action', {
    currentTime: getPlayerCurrentTime(),
    isPlaying
  });
}

function togglePlayPause() {
  const isPlaying = currentEngine === 'youtube' ? (ytPlayer && ytPlayer.getPlayerState() === 1) : !video.paused;
  setPlayerState(!isPlaying);
  triggerFlashIcon(!isPlaying);
  emitPlayerAction(!isPlaying);
}

document.getElementById('tap-center').onclick = togglePlayPause;
btnPlayPause.onclick = togglePlayPause;

let leftClicks = 0, rightClicks = 0;
document.getElementById('tap-left').onclick = () => {
  leftClicks++;
  setTimeout(() => {
    if (leftClicks >= 2) {
      setPlayerTime(Math.max(0, getPlayerCurrentTime() - 10));
      emitPlayerAction();
      showToast('⏪ 10 сек');
    }
    leftClicks = 0;
  }, 220);
};

document.getElementById('tap-right').onclick = () => {
  rightClicks++;
  setTimeout(() => {
    if (rightClicks >= 2) {
      setPlayerTime(Math.min(getPlayerDuration(), getPlayerCurrentTime() + 10));
      emitPlayerAction();
      showToast('10 сек ⏩');
    }
    rightClicks = 0;
  }, 220);
};

document.getElementById('btn-backward').onclick = () => { setPlayerTime(Math.max(0, getPlayerCurrentTime() - 10)); emitPlayerAction(); };
document.getElementById('btn-forward').onclick = () => { setPlayerTime(Math.min(getPlayerDuration(), getPlayerCurrentTime() + 10)); emitPlayerAction(); };

let controlsTimeout;
function showControls() {
  playerControls.classList.remove('hidden');
  clearTimeout(controlsTimeout);
  controlsTimeout = setTimeout(() => {
    const isPlaying = currentEngine === 'youtube' ? (ytPlayer && ytPlayer.getPlayerState() === 1) : !video.paused;
    if (isPlaying) playerControls.classList.add('hidden');
  }, 3500);
}
document.getElementById('player-container').addEventListener('mousemove', showControls);
document.getElementById('player-container').addEventListener('touchstart', showControls);

setInterval(() => {
  const cur = getPlayerCurrentTime();
  const dur = getPlayerDuration();
  if (dur > 0) {
    seekFill.style.width = (cur / dur * 100) + '%';
    timeDisplay.innerText = `${formatTime(cur)} / ${formatTime(dur)}`;
    if (video.buffered && video.buffered.length > 0) {
      seekBuffered.style.width = (video.buffered.end(video.buffered.length - 1) / dur * 100) + '%';
    }
  }
}, 300);

seekBar.onclick = (e) => {
  const dur = getPlayerDuration();
  if (dur <= 0) return;
  const rect = seekBar.getBoundingClientRect();
  setPlayerTime(((e.clientX - rect.left) / rect.width) * dur);
  emitPlayerAction();
};

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
}

document.getElementById('btn-fullscreen').onclick = async () => {
  const c = document.getElementById('player-container');
  if (!document.fullscreenElement) {
    if (c.requestFullscreen) await c.requestFullscreen();
    else if (c.webkitRequestFullscreen) await c.webkitRequestFullscreen();
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } else {
    document.exitFullscreen();
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
  }
};

// --- 4. ХОСТ-СИНХРОНИЗАЦИЯ ---
setInterval(() => {
  if (isHost && socket && socket.connected) {
    const isPlaying = currentEngine === 'youtube' ? (ytPlayer && ytPlayer.getPlayerState() === 1) : !video.paused;
    socket.emit('host_heartbeat', {
      currentTime: getPlayerCurrentTime(),
      isPlaying
    });
  }
}, 1500);

document.getElementById('btn-force-sync').onclick = () => {
  showToast('Синхронизация с хостом...');
  if (socket) socket.emit('join_room', { roomId, username: myUsername });
};

// --- 5. СТРИМ ЭКРАНА С ПРОВЕРКОЙ НА ПК ---
document.getElementById('btn-screenshare').onclick = async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    alert('Стрим экрана поддерживается на компьютерах (Windows, Mac, Linux). Мобильные браузеры блокируют захват экрана из соображений безопасности. Запустите трансляцию с ПК, а с телефона смотрите!');
    return;
  }

  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, width: 1280, height: 720 },
      audio: true
    });
    stopAllMedia();
    streamVideo.style.display = 'block';
    streamVideo.srcObject = screenStream;

    socket.emit('start_screen_stream');
    screenStream.getVideoTracks()[0].onended = () => socket.emit('stop_screen_stream');
    showToast('Трансляция экрана запущена!');
  } catch (err) {
    showToast('Стрим отменен');
  }
};

// --- 6. WEBRTC ГОЛОСОВОЙ ЧАТ ---
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const btnMic = document.getElementById('btn-mic');
const micLabel = document.getElementById('mic-label');

btnMic.onclick = async () => {
  if (!localVoiceStream) {
    try {
      localVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      isMicActive = true;
      btnMic.classList.add('active');
      micLabel.innerText = 'Голос (Вкл)';
      if (socket) socket.emit('toggle_mic_status', true);
      showToast('Микрофон включен!');
    } catch (e) {
      return showToast('Разрешите микрофон в браузере');
    }
  } else {
    isMicActive = !isMicActive;
    localVoiceStream.getAudioTracks().forEach(t => t.enabled = isMicActive);
    btnMic.classList.toggle('active', isMicActive);
    micLabel.innerText = isMicActive ? 'Голос (Вкл)' : 'Голос (Выкл)';
    if (socket) socket.emit('toggle_mic_status', isMicActive);
    showToast(isMicActive ? 'Микрофон включен' : 'Микрофон отключен');
  }
};

// --- 7. ЧАТ И КАСТОМНЫЙ ПЛЕЕР ГОЛОСОВЫХ ---
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-text-input');
const chatScroller = document.getElementById('chat-scroller');
const fileInput = document.getElementById('file-input');
const btnVoiceToggle = document.getElementById('btn-voice-toggle');
const voiceBar = document.getElementById('voice-record-bar');
const voiceTimer = document.getElementById('voice-timer');
const btnCancelVoice = document.getElementById('btn-cancel-voice');
const btnSendVoice = document.getElementById('btn-send-voice');

let mediaRecorder = null;
let voiceChunks = [];
let voiceSeconds = 0;
let voiceTimerInt = null;

chatForm.onsubmit = (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (text && socket) {
    socket.emit('chat_send', { text });
    chatInput.value = '';
  }
};

fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (!file || !socket) return;
  const reader = new FileReader();
  reader.onload = () => {
    let t = file.type.startsWith('image/') ? 'image' : (file.type.startsWith('video/') ? 'video' : 'file');
    socket.emit('chat_send', { fileData: reader.result, fileType: t });
    fileInput.value = '';
  };
  reader.readAsDataURL(file);
};

btnVoiceToggle.onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks = [];
    let mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    mediaRecorder.ondataavailable = e => voiceChunks.push(e.data);

    mediaRecorder.start();
    voiceBar.style.display = 'flex';
    voiceSeconds = 0;
    voiceTimer.innerText = '00:00';
    voiceTimerInt = setInterval(() => {
      voiceSeconds++;
      const m = Math.floor(voiceSeconds / 60);
      const s = voiceSeconds % 60;
      voiceTimer.innerText = `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }, 1000);
  } catch (err) {
    showToast('Нет доступа к микрофону');
  }
};

btnCancelVoice.onclick = () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  clearInterval(voiceTimerInt);
  voiceBar.style.display = 'none';
};

btnSendVoice.onclick = () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.onstop = () => {
      const mime = mediaRecorder.mimeType;
      const blob = new Blob(voiceChunks, { type: mime });
      const reader = new FileReader();
      reader.onload = () => {
        if (socket) socket.emit('chat_send', { fileData: reader.result, fileType: 'audio', audioDuration: voiceSeconds });
      };
      reader.readAsDataURL(blob);
    };
    mediaRecorder.stop();
  }
  clearInterval(voiceTimerInt);
  voiceBar.style.display = 'none';
};

function appendMessageUI(msg) {
  const div = document.createElement('div');
  
  if (msg.system) {
    div.className = 'chat-msg system';
    div.innerText = msg.text;
  } else {
    const isMe = (myId && msg.senderId === myId) || (msg.username === myUsername);
    div.className = `chat-msg ${isMe ? 'self' : 'other'}`;

    let mediaHTML = '';
    if (msg.fileData) {
      if (msg.fileType === 'image') {
        mediaHTML = `<img src="${msg.fileData}" class="msg-media">`;
      } else if (msg.fileType === 'video') {
        mediaHTML = `<video src="${msg.fileData}" controls class="msg-media"></video>`;
      } else if (msg.fileType === 'audio') {
        mediaHTML = `
          <div class="voice-msg-player">
            <button class="btn-voice-play" type="button">
              <svg class="icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <div class="voice-wave-container">
              <div class="voice-wave-bar"><div class="voice-wave-progress"></div></div>
              <div class="voice-meta-row">
                <span class="voice-time">0:00 / ${formatTime(msg.audioDuration || 0)}</span>
                <span class="voice-speed-pill">1x</span>
              </div>
            </div>
            <audio src="${msg.fileData}" style="display:none;"></audio>
          </div>
        `;
      }
    }

    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-user">${escapeHTML(msg.username)}</span>
      </div>
      ${msg.text ? `<div class="msg-text">${escapeHTML(msg.text)}</div>` : ''}
      ${mediaHTML}
      <div class="msg-time">${msg.time}</div>
    `;

    if (msg.fileType === 'audio') {
      setTimeout(() => initVoicePlayer(div), 50);
    }
  }

  chatScroller.appendChild(div);
  chatScroller.scrollTop = chatScroller.scrollHeight;
}

function initVoicePlayer(container) {
  const audio = container.querySelector('audio');
  const btnPlay = container.querySelector('.btn-voice-play');
  const bar = container.querySelector('.voice-wave-bar');
  const progress = container.querySelector('.voice-wave-progress');
  const timeText = container.querySelector('.voice-time');
  const speedPill = container.querySelector('.voice-speed-pill');

  if (!audio) return;

  btnPlay.onclick = () => {
    if (audio.paused) {
      document.querySelectorAll('audio').forEach(a => { if (a !== audio) a.pause(); });
      audio.play();
      btnPlay.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
    } else {
      audio.pause();
      btnPlay.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    }
  };

  audio.ontimeupdate = () => {
    if (audio.duration) {
      progress.style.width = (audio.currentTime / audio.duration * 100) + '%';
      timeText.innerText = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
    }
  };

  audio.onended = () => {
    btnPlay.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    progress.style.width = '0%';
  };

  bar.onclick = (e) => {
    if (!audio.duration) return;
    const rect = bar.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
  };

  speedPill.onclick = () => {
    if (audio.playbackRate === 1) audio.playbackRate = 1.5;
    else if (audio.playbackRate === 1.5) audio.playbackRate = 2;
    else audio.playbackRate = 1;
    speedPill.innerText = audio.playbackRate + 'x';
  };
}

// --- 8. СОКЕТЫ И АНТИ-ЗАКЛИНИВАНИЕ ---
if (socket) {
  socket.on('init_state', ({ roomState, messages, myId: id, isHost: hostFlag }) => {
    myId = id;
    isHost = hostFlag;
    currentHostId = roomState.hostId;
    updateHostUI();

    if (roomState.videoUrl) {
      loadMediaSource(roomState.videoUrl);
      setTimeout(() => {
        setPlayerTime(roomState.currentTime || 0);
        if (roomState.isPlaying) setPlayerState(true);
      }, 700);
    }

    updateQueueUI(roomState.queue || []);
    updatePeersListUI(roomState.peers || {});
    chatScroller.innerHTML = '';
    (messages || []).forEach(appendMessageUI);
  });

  socket.on('host_changed', ({ hostId }) => {
    currentHostId = hostId;
    isHost = (myId === hostId);
    updateHostUI();
    showToast(isHost ? 'Вы назначены Хостом!' : 'Ведущий сменился');
  });

  socket.on('sync_player', ({ currentTime, isPlaying }) => {
    markRemoteSync(1200); // Глушим эхо-паузу на 1.2 сек
    const cur = getPlayerCurrentTime();
    if (Math.abs(cur - currentTime) > 0.8) setPlayerTime(currentTime);
    setPlayerState(isPlaying);
  });

  socket.on('heartbeat_sync', ({ currentTime, isPlaying }) => {
    if (isHost) return;
    markRemoteSync(500);
    const cur = getPlayerCurrentTime();
    const drift = Math.abs(cur - currentTime);

    if (drift > 1.2) {
      setPlayerTime(currentTime);
    } else if (drift > 0.35) {
      video.playbackRate = cur < currentTime ? 1.08 : 0.92;
    } else {
      video.playbackRate = 1.0;
    }
    setPlayerState(isPlaying);
  });

  socket.on('video_switched', ({ url, title }) => {
    loadMediaSource(url);
    showToast(`Сейчас играет: ${title}`);
  });

  socket.on('chat_message', appendMessageUI);
  socket.on('queue_updated', updateQueueUI);
  socket.on('update_peers_list', updatePeersListUI);
}

function updateHostUI() {
  document.getElementById('host-badge').style.display = isHost ? 'inline-block' : 'none';
}

function updatePeersListUI(peers) {
  const container = document.getElementById('voice-users-list');
  container.innerHTML = '';
  Object.entries(peers).forEach(([id, u]) => {
    const chip = document.createElement('div');
    chip.className = `voice-user-chip ${u.isMicOn ? 'speaking' : ''}`;
    chip.innerHTML = `
      <span class="voice-user-dot ${u.isMicOn ? 'on' : ''}"></span>
      <span>${escapeHTML(u.username)}</span>
    `;
    container.appendChild(chip);
  });
}

// Очередь
document.getElementById('btn-play-now').onclick = () => {
  const url = document.getElementById('media-url-input').value.trim();
  const title = document.getElementById('media-title-input').value.trim() || url;
  if (!url) return showToast('Вставьте ссылку');
  if (socket) socket.emit('change_video_direct', { url, title });
  document.getElementById('media-url-input').value = '';
  switchTab('chat');
};

document.getElementById('btn-add-queue').onclick = () => {
  const url = document.getElementById('media-url-input').value.trim();
  const title = document.getElementById('media-title-input').value.trim() || url;
  if (!url) return showToast('Вставьте ссылку');
  if (socket) socket.emit('add_to_queue', { url, title });
  document.getElementById('media-url-input').value = '';
  showToast('Добавлено в очередь');
};

document.querySelectorAll('.sample-chip').forEach(btn => {
  btn.onclick = () => {
    document.getElementById('media-url-input').value = btn.dataset.url;
    document.getElementById('media-title-input').value = btn.dataset.title;
  };
});

function updateQueueUI(queue) {
  document.getElementById('queue-badge').innerText = queue.length;
  const c = document.getElementById('queue-items-container');
  c.innerHTML = queue.length === 0 ? '<div class="empty-state">Очередь пуста</div>' : '';
  queue.forEach(it => {
    const d = document.createElement('div');
    d.className = 'queue-card';
    d.innerHTML = `
      <div><div class="queue-title">${escapeHTML(it.title)}</div></div>
      <div>
        <button class="btn btn-secondary" onclick="socket.emit('play_queue_item', '${it.id}')">▶</button>
        <button class="btn btn-secondary" onclick="socket.emit('remove_from_queue', '${it.id}')">✕</button>
      </div>
    `;
    c.appendChild(d);
  });
}

document.getElementById('btn-skip-next').onclick = () => {
  const first = document.querySelector('.queue-card button');
  if (first) first.click();
};
video.onended = () => {
  const first = document.querySelector('.queue-card button');
  if (first) first.click();
};

function switchTab(k) {
  ['chat', 'queue', 'add'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === k);
    document.getElementById(`view-${t}`).classList.toggle('active', t === k);
  });
}
document.getElementById('tab-chat').onclick = () => switchTab('chat');
document.getElementById('tab-queue').onclick = () => switchTab('queue');
document.getElementById('tab-add').onclick = () => switchTab('add');

function escapeHTML(s) {
  return String(s).replace(/[&<>'"]/g, t => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[t] || t));
}
