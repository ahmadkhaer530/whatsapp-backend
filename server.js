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
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ================================
// ⚙️ CONFIG — পরিবর্তন করুন
// ================================
const PORT = process.env.PORT || 3000;
const TEAM_MEMBERS = [
  { id: 1, name: 'Admin', username: 'admin', password: 'admin123', color: '#6C63FF', role: 'admin' },
  { id: 2, name: 'Rahim',  username: 'rahim',  password: 'rahim123',  color: '#00BFA6', role: 'agent' },
  { id: 3, name: 'Karim',  username: 'karim',  password: 'karim123',  color: '#FF6B6B', role: 'agent' },
  { id: 4, name: 'Mitu',   username: 'mitu',   password: 'mitu123',   color: '#FFB347', role: 'agent' },
  { id: 5, name: 'Sadia',  username: 'sadia',  password: 'sadia123',  color: '#4FC3F7', role: 'agent' },
  { id: 6, name: 'Hasan',  username: 'hasan',  password: 'hasan123',  color: '#AED581', role: 'agent' },
  { id: 7, name: 'Nadia',  username: 'nadia',  password: 'nadia123',  color: '#F48FB1', role: 'agent' },
];
// ================================

// In-memory storage
let conversations = {};  // { jid: { contact, messages: [], assignedTo, unread } }
let onlineAgents = {};   // { socketId: memberObj }
let waSocket = null;
let qrCode = null;
let waStatus = 'disconnected'; // disconnected | qr | connecting | connected

// ── WhatsApp Connection ──────────────────────────────
async function connectWhatsApp() {
  const authDir = path.join(__dirname, 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

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
      qrCode = qr;
      waStatus = 'qr';
      io.emit('wa:qr', { qr });
      io.emit('wa:status', { status: 'qr' });
      console.log('📱 QR code ready — scan with WhatsApp');
    }

    if (connection === 'open') {
      qrCode = null;
      waStatus = 'connected';
      io.emit('wa:status', { status: 'connected', phone: sock.user?.id?.split(':')[0] });
      console.log('✅ WhatsApp connected:', sock.user?.id);
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      waStatus = 'disconnected';
      io.emit('wa:status', { status: 'disconnected' });
      console.log('❌ Disconnected. Reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectWhatsApp, 3000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Incoming messages ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue; // skip groups

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        (msg.message?.imageMessage ? '[Image]' : '') ||
        (msg.message?.audioMessage ? '[Audio]' : '') ||
        (msg.message?.documentMessage ? '[Document]' : '') ||
        '[Message]';

      const phone = jid.split('@')[0];
      const contactName = msg.pushName || phone;

      // Init conversation
      if (!conversations[jid]) {
        conversations[jid] = {
          jid,
          phone,
          name: contactName,
          messages: [],
          assignedTo: null,
          unread: 0,
          lastActivity: Date.now(),
        };
      }

      const msgObj = {
        id: msg.key.id,
        text,
        from: 'customer',
        time: (msg.messageTimestamp * 1000) || Date.now(),
        status: 'received',
      };

      conversations[jid].messages.push(msgObj);
      conversations[jid].unread += 1;
      conversations[jid].lastActivity = Date.now();
      if (msg.pushName) conversations[jid].name = msg.pushName;

      io.emit('message:new', {
        jid,
        contact: { jid, phone, name: conversations[jid].name },
        message: msgObj,
        unread: conversations[jid].unread,
        assignedTo: conversations[jid].assignedTo,
      });

      console.log(`📩 [${contactName}] ${text}`);
    }
  });
}

// ── Socket.io Events ─────────────────────────────────


socket.on('wa:connect:new', () => {
  connectWhatsApp();
});

socket.on('wa:disconnect', () => {
  if (waSocket) {
    waSocket.logout();
    waSocket = null;
    waStatus = 'disconnected';
    io.emit('wa:status', { status: 'disconnected' });
  }
});



io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Login
  socket.on('agent:login', ({ username, password }) => {
    const member = TEAM_MEMBERS.find(m => m.username === username && m.password === password);
    if (!member) {
      socket.emit('agent:login:error', { message: 'ভুল username বা password' });
      return;
    }
    onlineAgents[socket.id] = { ...member, socketId: socket.id };
    socket.emit('agent:login:success', { member });
    io.emit('agents:online', Object.values(onlineAgents));

    // Send current state
    socket.emit('wa:status', { status: waStatus, qr: qrCode });
    socket.emit('conversations:all', Object.values(conversations).sort((a,b) => b.lastActivity - a.lastActivity));
    console.log(`👤 ${member.name} logged in`);
  });

  // Send message
  socket.on('message:send', async ({ jid, text }) => {
    const agent = onlineAgents[socket.id];
    if (!agent || !waSocket || waStatus !== 'connected') return;

    try {
      await waSocket.sendMessage(jid, { text });

      const msgObj = {
        id: Date.now().toString(),
        text,
        from: 'agent',
        agentName: agent.name,
        agentColor: agent.color,
        time: Date.now(),
        status: 'sent',
      };

      if (conversations[jid]) {
        conversations[jid].messages.push(msgObj);
        conversations[jid].unread = 0;
        conversations[jid].lastActivity = Date.now();
      }

      io.emit('message:sent', { jid, message: msgObj });
    } catch (err) {
      socket.emit('message:error', { error: 'মেসেজ পাঠানো যায়নি' });
      console.error('Send error:', err.message);
    }
  });

  // Assign conversation
  socket.on('conversation:assign', ({ jid, agentId }) => {
    const agent = onlineAgents[socket.id];
    if (!agent) return;
    if (conversations[jid]) {
      conversations[jid].assignedTo = agentId;
      io.emit('conversation:assigned', { jid, agentId });
    }
  });

  // Mark read
  socket.on('conversation:read', ({ jid }) => {
    if (conversations[jid]) {
      conversations[jid].unread = 0;
      io.emit('conversation:read', { jid });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const agent = onlineAgents[socket.id];
    if (agent) {
      delete onlineAgents[socket.id];
      io.emit('agents:online', Object.values(onlineAgents));
      console.log(`👋 ${agent.name} disconnected`);
    }
  });
});

// ── REST ──────────────────────────────────────────────
app.get('/api/status', (_, res) => res.json({ status: waStatus }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));

// ── Start ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Team Inbox চালু: http://localhost:${PORT}`);
  console.log('📋 Team members:', TEAM_MEMBERS.map(m => m.username).join(', '));
  connectWhatsApp();
});
