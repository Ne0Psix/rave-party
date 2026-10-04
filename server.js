const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024 // Поддержка отправки файлов/медиа до 50MB
});

app.use(express.static(path.join(__dirname, 'public')));

// База данных комнат в оперативной памяти
const rooms = {};

io.on('connection', (socket) => {
  // --- 1. NTP КАЛИБРОВКА ВРЕМЕНИ ДЛЯ МИКРОСЕКУНДНОЙ СИНХРОНИЗАЦИИ ---
  socket.on('sync_ntp', (clientTimestamp) => {
    socket.emit('sync_ntp_response', {
      clientTimestamp,
      serverTimestamp: Date.now()
    });
  });

  // --- 2. ВХОД В КОМНАТУ ---
  socket.on('join_room', ({ roomId, username }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username || 'Пользователь';

    if (!rooms[roomId]) {
      rooms[roomId] = {
        host: socket.id,
        mode: 'file', // 'file' или 'webrtc_stream'
        videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
        currentTime: 0,
        isPlaying: false,
        lastUpdate: Date.now(),
        queue: [],
        messages: [],
        broadcasterId: null
      };
    }

    const room = rooms[roomId];

    // Отправляем новому участнику текущее состояние комнаты
    socket.emit('init_state', {
      roomState: {
        mode: room.mode,
        videoUrl: room.videoUrl,
        currentTime: room.currentTime,
        isPlaying: room.isPlaying,
        lastUpdate: room.lastUpdate,
        queue: room.queue,
        broadcasterId: room.broadcasterId
      },
      messages: room.messages,
      isHost: room.host === socket.id
    });

    // Оповещаем остальных о новом участнике (для WebRTC Voice Mesh)
    socket.to(roomId).emit('peer_joined', {
      peerId: socket.id,
      username: socket.username
    });

    io.to(roomId).emit('chat_message', {
      id: 'sys_' + Date.now(),
      system: true,
      text: `${socket.username} вошел в комнату`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // --- 3. СИНХРОНИЗАЦИЯ ПЛЕЕРА ---
  socket.on('player_action', (data) => {
    const room = rooms[socket.roomId];
    if (!room) return;

    room.currentTime = data.currentTime;
    room.isPlaying = data.isPlaying;
    room.lastUpdate = Date.now();

    socket.to(socket.roomId).emit('sync_player', {
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      serverTimestamp: room.lastUpdate
    });
  });

  // --- 4. ОЧЕРЕДЬ И СМЕНА ВИДЕО ---
  socket.on('change_video_direct', ({ url, title }) => {
    const room = rooms[socket.roomId];
    if (!room) return;

    room.mode = 'file';
    room.videoUrl = url;
    room.currentTime = 0;
    room.isPlaying = false;
    room.lastUpdate = Date.now();

    io.to(socket.roomId).emit('video_switched', {
      url: room.videoUrl,
      title: title || 'Новое видео',
      mode: 'file'
    });
  });

  socket.on('add_to_queue', ({ url, title }) => {
    const room = rooms[socket.roomId];
    if (!room) return;

    const item = {
      id: 'q_' + Date.now() + Math.random().toString(36).substr(2, 4),
      url,
      title: title || url,
      addedBy: socket.username
    };

    room.queue.push(item);
    io.to(socket.roomId).emit('queue_updated', room.queue);
  });

  socket.on('play_queue_item', (itemId) => {
    const room = rooms[socket.roomId];
    if (!room) return;

    const index = room.queue.findIndex(i => i.id === itemId);
    if (index !== -1) {
      const nextItem = room.queue.splice(index, 1)[0];
      room.mode = 'file';
      room.videoUrl = nextItem.url;
      room.currentTime = 0;
      room.isPlaying = true;
      room.lastUpdate = Date.now();

      io.to(socket.roomId).emit('queue_updated', room.queue);
      io.to(socket.roomId).emit('video_switched', {
        url: room.videoUrl,
        title: nextItem.title,
        mode: 'file'
      });
    }
  });

  socket.on('remove_from_queue', (itemId) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.queue = room.queue.filter(i => i.id !== itemId);
    io.to(socket.roomId).emit('queue_updated', room.queue);
  });

  // --- 5. WEBRTC СТРИМ ВКЛАДКИ / ЭКРАНА (ДЛЯ VK, КИНОПОИСКА И ЛЮБЫХ САЙТОВ) ---
  socket.on('start_screen_stream', () => {
    const room = rooms[socket.roomId];
    if (!room) return;

    room.mode = 'webrtc_stream';
    room.broadcasterId = socket.id;

    io.to(socket.roomId).emit('screen_stream_started', { broadcasterId: socket.id });
  });

  socket.on('stop_screen_stream', () => {
    const room = rooms[socket.roomId];
    if (!room) return;

    room.mode = 'file';
    room.broadcasterId = null;

    io.to(socket.roomId).emit('screen_stream_stopped', { fallbackUrl: room.videoUrl });
  });

  // --- 6. WEBRTC СИГНАЛЫ (ГОЛОС + СТРИМ ЭКРАНА) ---
  socket.on('signal_relay', ({ targetPeerId, signal, type }) => {
    io.to(targetPeerId).emit('signal_relay_received', {
      senderPeerId: socket.id,
      senderUsername: socket.username,
      signal,
      type // 'voice' или 'screen'
    });
  });

  // --- 7. ЧАТ, МЕДИАФАЙЛЫ И РЕАКЦИИ ---
  socket.on('chat_send', (data) => {
    const room = rooms[socket.roomId];
    if (!room) return;

    const msg = {
      id: 'msg_' + Date.now() + Math.random().toString(36).substr(2, 4),
      username: socket.username,
      text: data.text || null,
      fileData: data.fileData || null, // Base64 файла (картинка, видео или аудио-войс)
      fileName: data.fileName || null,
      fileType: data.fileType || null, // 'image', 'video', 'audio', 'file'
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reactions: {} // emoji -> [username]
    };

    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift(); // Ограничение буфера истории

    io.to(socket.roomId).emit('chat_message', msg);
  });

  socket.on('add_reaction', ({ messageId, emoji }) => {
    const room = rooms[socket.roomId];
    if (!room) return;

    const msg = room.messages.find(m => m.id === messageId);
    if (msg) {
      if (!msg.reactions[emoji]) {
        msg.reactions[emoji] = [];
      }
      const userIndex = msg.reactions[emoji].indexOf(socket.username);
      if (userIndex === -1) {
        msg.reactions[emoji].push(socket.username);
      } else {
        msg.reactions[emoji].splice(userIndex, 1);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
      }
      io.to(socket.roomId).emit('reaction_updated', { messageId, reactions: msg.reactions });
    }
  });

  // --- 8. ВЫХОД И ОТКЛЮЧЕНИЕ ---
  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      const room = rooms[socket.roomId];
      io.to(socket.roomId).emit('peer_left', { peerId: socket.id });

      io.to(socket.roomId).emit('chat_message', {
        id: 'sys_' + Date.now(),
        system: true,
        text: `${socket.username} покинул комнату`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });

      if (room.broadcasterId === socket.id) {
        room.mode = 'file';
        room.broadcasterId = null;
        io.to(socket.roomId).emit('screen_stream_stopped', { fallbackUrl: room.videoUrl });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Rave Ultimate] Сервер запущен: http://localhost:${PORT}`);
});