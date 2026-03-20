const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// ================================
// ⚙️ TEAM MEMBERS
// ================================
const TEAM_MEMBERS = [
  { id: 1, name: 'Admin', username: 'admin', password: 'admin123', color: '#6C63FF', role: 'admin' },
  { id: 2, name: 'Rahim',  username: 'rahim',  password: 'rahim123',  color: '#00BFA6', role: 'agent' },
  { id: 3, name: 'Karim',  username: 'karim',  password: 'karim123',  color: '#FF6B6B', role: 'agent' },
  { id: 4, name: 'Mitu',   username: 'mitu',   password: 'mitu123',   color: '#FFB347', role: 'agent' },
  { id: 5, name: 'Sadia',  username: 'sadia',  password: 'sadia123',  color: '#4FC3F7', role: 'agent' },
  { id: 6, name: 'Hasan',  username: 'hasan',  password: 'hasan123',  color: '#AED581', role: 'agent' },
  { id: 7, name: 'Nadia',  username: 'nadia',  password: 'nadia123',  color: '#F48FB1', role: 'agent' },
];

// In-memory storage
let conversations = {};
let onlineAgents = {};
let waSocket = null;
let waStatus = 'disconnected';

// ── WhatsApp Connection ──────────────────────────────
async function connectWhatsApp() {
  const authDir = path.join('/tmp', 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['TeamInbox', 'Chrome', '1.0'],
  });

  waSocket = sock;

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      waStatus = 'qr';
      io.emit('wa:qr', { qr });
      io.emit('wa:status', { status: 'qr' });
      console.log('📱 QR ready');
    }

    if (connection === 'open') {
      waStatus = 'connected';
      io.emit('wa:status', { status: 'connected', phone: sock.user?.id?.split(':')[0] });
      console.log('✅ WhatsApp connected:', sock.user?.id);
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode : undefined;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      waStatus = 'disconnected';
      io.emit('wa:status', { status: 'disconnected' });
      if (shouldReconnect) setTimeout(connectWhatsApp, 3000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        (msg.message?.imageMessage ? '[Image]' : '') ||
        (msg.message?.audioMessage ? '[Audio]' : '') ||
        '[Message]';

      const phone = jid.split('@')[0];

      if (!conversations[jid]) {
        conversations[jid] = { jid, phone, name: msg.pushName || phone, messages: [], assignedTo: null, unread: 0, lastActivity: Date.now() };
      }

      const msgObj = { id: msg.key.id, text, from: 'customer', time: (msg.messageTimestamp * 1000) || Date.now() };
      conversations[jid].messages.push(msgObj);
      conversations[jid].unread += 1;
      conversations[jid].lastActivity = Date.now();
      if (msg.pushName) conversations[jid].name = msg.pushName;

      io.emit('message:new', {
        jid, contact: { jid, phone, name: conversations[jid].name },
        message: msgObj, unread: conversations[jid].unread, assignedTo: conversations[jid].assignedTo,
      });
    }
  });
}

// ── Socket.io Events ─────────────────────────────────
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Login
  socket.on('agent:login', ({ username, password }) => {
    const member = TEAM_MEMBERS.find(m => m.username === username && m.password === password);
    if (!member) { socket.emit('agent:login:error', { message: 'ভুল username বা password' }); return; }
    onlineAgents[socket.id] = { ...member, socketId: socket.id };
    socket.emit('agent:login:success', { member });
    io.emit('agents:online', Object.values(onlineAgents));
    socket.emit('wa:status', { status: waStatus });
    socket.emit('conversations:all', Object.values(conversations).sort((a,b) => b.lastActivity - a.lastActivity));
    console.log(`👤 ${member.name} logged in`);
  });

  // Connect new WhatsApp
  socket.on('wa:connect:new', () => {
    console.log('🔄 New WA connection requested');
    connectWhatsApp();
  });

  // Disconnect WhatsApp
  socket.on('wa:disconnect', async () => {
    if (waSocket) {
      try { await waSocket.logout(); } catch(e) {}
      waSocket = null;
      waStatus = 'disconnected';
      io.emit('wa:status', { status: 'disconnected' });
    }
  });

  // Send message
  socket.on('message:send', async ({ jid, text }) => {
    const agent = onlineAgents[socket.id];
    if (!agent || !waSocket || waStatus !== 'connected') return;
    try {
      await waSocket.sendMessage(jid, { text });
      const msgObj = { id: Date.now().toString(), text, from: 'agent', agentName: agent.name, agentColor: agent.color, time: Date.now() };
      if (conversations[jid]) { conversations[jid].messages.push(msgObj); conversations[jid].unread = 0; conversations[jid].lastActivity = Date.now(); }
      io.emit('message:sent', { jid, message: msgObj });
    } catch (err) { socket.emit('message:error', { error: 'মেসেজ পাঠানো যায়নি' }); }
  });

  // Assign conversation
  socket.on('conversation:assign', ({ jid, agentId }) => {
    if (conversations[jid]) { conversations[jid].assignedTo = agentId; io.emit('conversation:assigned', { jid, agentId }); }
  });

  // Mark read
  socket.on('conversation:read', ({ jid }) => {
    if (conversations[jid]) { conversations[jid].unread = 0; io.emit('conversation:read', { jid }); }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const agent = onlineAgents[socket.id];
    if (agent) { delete onlineAgents[socket.id]; io.emit('agents:online', Object.values(onlineAgents)); console.log(`👋 ${agent.name} disconnected`); }
  });
});

// ── REST ──────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', wa: waStatus }));
app.get('/', (_, res) => res.json({ message: '✅ WhatsApp Team Inbox Backend চালু আছে!', status: waStatus }));

// ── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Backend চালু: port ${PORT}`);
  connectWhatsApp();
});
