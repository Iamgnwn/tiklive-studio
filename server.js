const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const tiktokLib = require('tiktok-live-connector');

const TikTokConnector = tiktokLib.TikTokLiveConnection || tiktokLib.WebcastPushConnection;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let tiktokConnection = null;
let lastTtsTime = 0;

const state = {
  connected: false,
  username: '',
  stats: { viewers: 0, likes: 0, followers: 0, diamonds: 0 },
  goals: { likeGoal: 10000, followerGoal: 100, diamondGoal: 1000 },
  tts: { enabled: true, mode: 'all', commandPrefix: '!tts', readGifts: true, cooldownSec: 3 },
  timer: { seconds: 300, running: false, addPerFollow: 10, addPerDiamond: 2 },
  poll: {
    active: false,
    question: 'Main game apa selanjutnya?',
    options: [
      { key: '!1', label: 'Mobile Legends', votes: 0 },
      { key: '!2', label: 'PUBG Mobile', votes: 0 },
      { key: '!3', label: 'Valorant', votes: 0 }
    ],
    voters: new Set()
  },
  wheel: {
    items: ['ZONK 😅', 'Push Up 5x 💪', 'Nyanyi Lagu 🎤', 'Mabar Bareng 🎮', 'VIP Mod ⭐', 'Minum Air 💧'],
    triggerGift: 'Rose'
  },
  rules: [
    { id: 1, event: 'gift', match: 'Rose', action: 'sound', value: 'coin', label: 'Gift Rose → Suara Coin' },
    { id: 2, event: 'gift', match: 'GG', action: 'spin', value: '', label: 'Gift GG → Putar Spin Wheel' },
    { id: 3, event: 'follow', match: '*', action: 'sound', value: 'chime', label: 'Follow Baru → Suara Chime' }
  ],
  overlayWidgets: {
    showAlerts: true, showGoals: true, showTimer: true,
    showLeaderboard: true, showChat: true, showPoll: true
  },
  topGifters: {}
};

function getPublicState() {
  const leaderboard = Object.entries(state.topGifters)
    .map(([uniqueId, d]) => ({ uniqueId, ...d }))
    .sort((a, b) => b.diamonds - a.diamonds)
    .slice(0, 5);

  return {
    connected: state.connected,
    username: state.username,
    stats: state.stats,
    goals: state.goals,
    tts: state.tts,
    timer: state.timer,
    poll: { active: state.poll.active, question: state.poll.question, options: state.poll.options },
    wheel: state.wheel,
    rules: state.rules,
    overlayWidgets: state.overlayWidgets,
    leaderboard
  };
}

function broadcastState() {
  io.emit('state-sync', getPublicState());
}

setInterval(() => {
  if (state.timer.running && state.timer.seconds > 0) {
    state.timer.seconds--;
    if (state.timer.seconds === 0) {
      state.timer.running = false;
      io.emit('play-sound', { sound: 'fanfare' });
    }
    io.emit('timer-tick', state.timer);
  }
}, 1000);

function handleChat(data) {
  const payload = {
    uniqueId: data.uniqueId,
    nickname: data.nickname || data.uniqueId,
    comment: data.comment || '',
    avatar: data.profilePictureUrl || ''
  };
  io.emit('tiktok-chat', payload);

  if (state.poll.active) {
    const cmd = payload.comment.trim().split(/\s+/)[0].toLowerCase();
    const opt = state.poll.options.find(o => o.key.toLowerCase() === cmd);
    if (opt && !state.poll.voters.has(payload.uniqueId)) {
      state.poll.voters.add(payload.uniqueId);
      opt.votes++;
      broadcastState();
    }
  }

  if (state.tts.enabled) {
    const now = Date.now();
    if ((now - lastTtsTime) / 1000 >= state.tts.cooldownSec) {
      let textToSpeak = '';
      if (state.tts.mode === 'all') {
        textToSpeak = `${payload.nickname} bilang: ${payload.comment}`;
      } else if (
        state.tts.mode === 'command' &&
        payload.comment.toLowerCase().startsWith(state.tts.commandPrefix.toLowerCase())
      ) {
        const cleanMsg = payload.comment.slice(state.tts.commandPrefix.length).trim();
        if (cleanMsg) textToSpeak = `${payload.nickname} bilang: ${cleanMsg}`;
      }
      if (textToSpeak) {
        lastTtsTime = now;
        io.emit('tts-speak', { text: textToSpeak });
      }
    }
  }
}

function handleGift(data) {
  if (data.giftType === 1 && !data.repeatEnd) return;
  const count = data.repeatCount || 1;
  const diamonds = (data.diamondCount || 1) * count;
  const giftName = data.giftName || 'Gift';

  state.stats.diamonds += diamonds;
  const uid = data.uniqueId;
  if (!state.topGifters[uid]) {
    state.topGifters[uid] = { nickname: data.nickname || uid, diamonds: 0, avatar: data.profilePictureUrl || '' };
  }
  state.topGifters[uid].diamonds += diamonds;

  if (state.timer.addPerDiamond > 0) {
    state.timer.seconds += diamonds * state.timer.addPerDiamond;
  }

  const payload = {
    uniqueId: uid,
    nickname: data.nickname || uid,
    giftName,
    count,
    diamonds,
    avatar: data.profilePictureUrl || '',
    giftIcon: data.giftPictureUrl || ''
  };

  io.emit('tiktok-gift', payload);
  broadcastState();

  if (state.tts.enabled && state.tts.readGifts) {
    io.emit('tts-speak', { text: `Terima kasih ${payload.nickname} sudah kirim ${count} ${giftName}!` });
  }

  runRules('gift', giftName, payload);

  if (state.wheel.triggerGift && giftName.toLowerCase() === state.wheel.triggerGift.trim().toLowerCase()) {
    triggerSpinWheel(payload.nickname);
  }
}

function handleFollow(data) {
  state.stats.followers += 1;
  if (state.timer.addPerFollow > 0) state.timer.seconds += state.timer.addPerFollow;
  const payload = { uniqueId: data.uniqueId, nickname: data.nickname || data.uniqueId };
  io.emit('tiktok-follow', payload);
  broadcastState();
  runRules('follow', '*', payload);
}

function handleLike(data) {
  const likes = data.likeCount || 1;
  state.stats.likes = data.totalLikeCount ? Math.max(state.stats.likes, data.totalLikeCount) : state.stats.likes + likes;
  io.emit('tiktok-like', { uniqueId: data.uniqueId, likeCount: likes, totalLikes: state.stats.likes });
  broadcastState();
}

function handleShare(data) {
  const payload = { uniqueId: data.uniqueId, nickname: data.nickname || data.uniqueId };
  io.emit('tiktok-share', payload);
  runRules('share', '*', payload);
}

function runRules(eventType, matchValue, payload) {
  state.rules.forEach(rule => {
    if (rule.event !== eventType) return;
    const isMatch = rule.match === '*' || rule.match.toLowerCase() === matchValue.toLowerCase();
    if (!isMatch) return;

    if (rule.action === 'sound') io.emit('play-sound', { sound: rule.value });
    else if (rule.action === 'spin') triggerSpinWheel(payload.nickname || 'Penonton');
    else if (rule.action === 'addTimer') {
      state.timer.seconds += parseInt(rule.value, 10) || 30;
      broadcastState();
    }
  });
}

function triggerSpinWheel(triggeredBy = 'Host') {
  if (!state.wheel.items.length) return;
  const winnerIndex = Math.floor(Math.random() * state.wheel.items.length);
  io.emit('spin-wheel', {
    winnerIndex,
    winnerText: state.wheel.items[winnerIndex],
    triggeredBy,
    items: state.wheel.items
  });
}

io.on('connection', socket => {
  socket.emit('state-sync', getPublicState());

  socket.on('connect-tiktok', async ({ username }) => {
    const cleanUser = (username || '').replace(/^@/, '').trim();
    if (!cleanUser) return socket.emit('system-log', { type: 'error', msg: 'Username tidak boleh kosong!' });

    if (tiktokConnection) {
      try { tiktokConnection.disconnect(); } catch {}
      tiktokConnection = null;
    }

    socket.emit('system-log', { type: 'info', msg: `Menghubungkan ke @${cleanUser}...` });
    try {
      tiktokConnection = new TikTokConnector(cleanUser, { processInitialData: false, enableExtendedGiftInfo: true });
      const roomState = await tiktokConnection.connect();
      state.connected = true;
      state.username = cleanUser;
      state.stats.viewers = roomState.roomInfo?.user_count || 0;
      socket.emit('system-log', { type: 'success', msg: `Terhubung ke Live @${cleanUser}!` });
      broadcastState();

      tiktokConnection.on('chat', handleChat);
      tiktokConnection.on('gift', handleGift);
      tiktokConnection.on('follow', handleFollow);
      tiktokConnection.on('like', handleLike);
      tiktokConnection.on('share', handleShare);
      tiktokConnection.on('roomUser', d => { state.stats.viewers = d.viewerCount || 0; broadcastState(); });
      tiktokConnection.on('streamEnd', () => {
        state.connected = false;
        io.emit('system-log', { type: 'warn', msg: 'Live TikTok berakhir.' });
        broadcastState();
      });
      tiktokConnection.on('disconnected', () => { state.connected = false; broadcastState(); });
    } catch (err) {
      state.connected = false;
      socket.emit('system-log', { type: 'error', msg: `Gagal konek @${cleanUser}: ${err.message}. Pastikan akun sedang LIVE!` });
      broadcastState();
    }
  });

  socket.on('disconnect-tiktok', () => {
    if (tiktokConnection) { try { tiktokConnection.disconnect(); } catch {} tiktokConnection = null; }
    state.connected = false;
    state.username = '';
    io.emit('system-log', { type: 'info', msg: 'Koneksi diputus.' });
    broadcastState();
  });

  socket.on('simulate-event', ({ type, data }) => {
    if (type === 'chat') handleChat(data);
    else if (type === 'gift') handleGift(data);
    else if (type === 'follow') handleFollow(data);
    else if (type === 'like') handleLike(data);
    else if (type === 'share') handleShare(data);
  });

  socket.on('update-settings', payload => {
    if (payload.goals) state.goals = { ...state.goals, ...payload.goals };
    if (payload.tts) state.tts = { ...state.tts, ...payload.tts };
    if (payload.wheel) state.wheel = { ...state.wheel, ...payload.wheel };
    if (payload.rules) state.rules = payload.rules;
    if (payload.overlayWidgets) state.overlayWidgets = { ...state.overlayWidgets, ...payload.overlayWidgets };
    if (payload.timerConfig) {
      state.timer.addPerFollow = payload.timerConfig.addPerFollow;
      state.timer.addPerDiamond = payload.timerConfig.addPerDiamond;
    }
    broadcastState();
  });

  socket.on('timer-control', ({ action, value }) => {
    if (action === 'start') state.timer.running = true;
    else if (action === 'pause') state.timer.running = false;
    else if (action === 'reset') { state.timer.running = false; state.timer.seconds = value || 300; }
    else if (action === 'add') state.timer.seconds = Math.max(0, state.timer.seconds + (value || 60));
    broadcastState();
  });

  socket.on('poll-control', ({ action, question, options }) => {
    if (action === 'start') {
      state.poll.active = true;
      state.poll.question = question || state.poll.question;
      state.poll.voters.clear();
      if (Array.isArray(options)) {
        state.poll.options = options.map((lbl, idx) => ({ key: `!${idx + 1}`, label: lbl, votes: 0 }));
      }
    } else if (action === 'stop') state.poll.active = false;
    else if (action === 'reset') { state.poll.voters.clear(); state.poll.options.forEach(o => (o.votes = 0)); }
    broadcastState();
  });

  socket.on('manual-spin', () => triggerSpinWheel('Host'));
  socket.on('play-sound', ({ sound }) => io.emit('play-sound', { sound }));
  socket.on('reset-stats', () => {
    state.stats = { viewers: 0, likes: 0, followers: 0, diamonds: 0 };
    state.topGifters = {};
    broadcastState();
  });
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n==================================================`);
  console.log(`📱 TikLive Mobile   : http://localhost:${PORT}/mobile.html`);
  console.log(`🌐 Akses HP Lain    : http://${ip}:${PORT}/mobile.html`);
  console.log(`📲 Overlay 9:16     : http://localhost:${PORT}/overlay.html?mode=mobile`);
  console.log(`💻 Dashboard PC     : http://localhost:${PORT}/index.html`);
  console.log(`==================================================\n`);
});