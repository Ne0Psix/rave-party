const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024 // До 50MB на фото/видео/аудио
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {
  // NTP Синхронизация времени
  socket.on('sync_ntp', (t) => {
    socket.emit('sync_ntp_response', { clientT: t, serverT: Date.now() });
  });

  // Вход в комнату
  socket.on('join_room', ({ roomId, username }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username || 'Пользователь';

    if (!rooms[roomId]) {
      rooms[roomId] = {
        hostId: socket.id,
        videoUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', // Качественный тестовый HLS с субтитрами
        currentTime: 0,
        isPlaying: false,
        lastUpdate: Date.now(),
        queue: [],
        messages: [],
        broadcasterId: null,
        peers: {} // socketId -> { username, isMicOn }
      };
    }

    const r = rooms[roomId];
    r.peers[socket.id] = { username: socket.username, isMicOn: false };

    // Если хост вышел ранее, назначаем нового
    if (!r.peers[r.hostId]) {
      r.hostId = socket.id;
    }

    socket.emit('init_state', {
      roomState: {
        hostId: r.hostId,
        videoUrl: r.videoUrl,
        currentTime: r.currentTime,
        isPlaying: r.isPlaying,
        lastUpdate: r.lastUpdate,
        queue: r.queue,
        broadcasterId: r.broadcasterId,
        peers: r.peers
      },
      messages: r.messages,
      myId: socket.id,
      isHost: r.hostId === socket.id
    });

    socket.to(roomId).emit('peer_joined_voice', {
      peerId: socket.id,
      username: socket.username
    });

    io.to(roomId).emit('update_peers_list', r.peers);

    io.to(roomId).emit('chat_message', {
      id: 'sys_' + Date.now(),
      system: true,
      text: `${socket.username} вошел в комнату`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // Синхронизация воспроизведения (Play / Pause / Seek)
  socket.on('player_action', (data) => {
    const r = rooms[socket.roomId];
    if (!r) return;

    r.currentTime = data.currentTime;
    r.isPlaying = data.isPlaying;
    r.lastUpdate = Date.now();

    socket.to(socket.roomId).emit('sync_player', {
      currentTime: r.currentTime,
      isPlaying: r.isPlaying,
      serverTimestamp: r.lastUpdate,
      senderId: socket.id
    });
  });

  // Сердцебиение синхронизации от Хоста (каждые 1.5 сек)
  socket.on('host_heartbeat', (data) => {
    const r = rooms[socket.roomId];
    if (!r || r.hostId !== socket.id) return;

    r.currentTime = data.currentTime;
    r.isPlaying = data.isPlaying;
    r.lastUpdate = Date.now();

    socket.to(socket.roomId).emit('heartbeat_sync', {
      currentTime: r.currentTime,
      isPlaying: r.isPlaying,
      serverTimestamp: r.lastUpdate
    });
  });

  // Смена видео
  socket.on('change_video_direct', ({ url, title }) => {
    const r = rooms[socket.roomId];
    if (!r) return;

    r.videoUrl = url;
    r.currentTime = 0;
    r.isPlaying = true;
    r.lastUpdate = Date.now();

    io.to(socket.roomId).emit('video_switched', {
      url: r.videoUrl,
      title: title || 'Новое видео'
    });
  });

  // Очередь
  socket.on('add_to_queue', ({ url, title }) => {
    const r = rooms[socket.roomId];
    if (!r) return;
    const item = { id: 'q_' + Date.now() + Math.random().toString(36).substr(2, 4), url, title, addedBy: socket.username };
    r.queue.push(item);
    io.to(socket.roomId).emit('queue_updated', r.queue);
  });

  socket.on('play_queue_item', (itemId) => {
    const r = rooms[socket.roomId];
    if (!r) return;
    const idx = r.queue.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      const it = r.queue.splice(idx, 1)[0];
      r.videoUrl = it.url;
      r.currentTime = 0;
      r.isPlaying = true;
      r.lastUpdate = Date.now();
      io.to(socket.roomId).emit('queue_updated', r.queue);
      io.to(socket.roomId).emit('video_switched', { url: r.videoUrl, title: it.title });
    }
  });

  socket.on('remove_from_queue', (itemId) => {
    const r = rooms[socket.roomId];
    if (!r) return;
    r.queue = r.queue.filter(i => i.id !== itemId);
    io.to(socket.roomId).emit('queue_updated', r.queue);
  });

  // Стрим экрана (VK, любые сайты)
  socket.on('start_screen_stream', () => {
    const r = rooms[socket.roomId];
    if (!r) return;
    r.broadcasterId = socket.id;
    io.to(socket.roomId).emit('screen_stream_started', { broadcasterId: socket.id });
  });

  socket.on('stop_screen_stream', () => {
    const r = rooms[socket.roomId];
    if (!r) return;
    r.broadcasterId = null;
    io.to(socket.roomId).emit('screen_stream_stopped', { fallbackUrl: r.videoUrl });
  });

  // WebRTC Сигнализация (Голосовой чат + Экран)
  socket.on('signal_relay', ({ targetPeerId, signal, type }) => {
    io.to(targetPeerId).emit('signal_relay_received', {
      senderPeerId: socket.id,
      senderUsername: socket.username,
      signal,
      type
    });
  });

  socket.on('toggle_mic_status', (isMicOn) => {
    const r = rooms[socket.roomId];
    if (r && r.peers[socket.id]) {
      r.peers[socket.id].isMicOn = isMicOn;
      io.to(socket.roomId).emit('update_peers_list', r.peers);
    }
  });

  // Чат и медиа
  socket.on('chat_send', (data) => {
    const r = rooms[socket.roomId];
    if (!r) return;

    const msg = {
      id: 'msg_' + Date.now() + Math.random().toString(36).substr(2, 4),
      senderId: socket.id,
      username: socket.username,
      text: data.text || null,
      fileData: data.fileData || null,
      fileType: data.fileType || null, // 'image', 'video', 'audio', 'file'
      audioDuration: data.audioDuration || null,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    r.messages.push(msg);
    if (r.messages.length > 200) r.messages.shift();

    io.to(socket.roomId).emit('chat_message', msg);
  });

  socket.on('disconnect', () => {
    const r = rooms[socket.roomId];
    if (r) {
      delete r.peers[socket.id];
      if (r.hostId === socket.id) {
        const remainingPeers = Object.keys(r.peers);
        r.hostId = remainingPeers.length > 0 ? remainingPeers[0] : null;
        if (r.hostId) {
          io.to(socket.roomId).emit('host_changed', { hostId: r.hostId });
        }
      }

      io.to(socket.roomId).emit('peer_left_voice', { peerId: socket.id });
      io.to(socket.roomId).emit('update_peers_list', r.peers);

      io.to(socket.roomId).emit('chat_message', {
        id: 'sys_' + Date.now(),
        system: true,
        text: `${socket.username} вышел`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rave Ultimate запущен на порту ${PORT}`));
