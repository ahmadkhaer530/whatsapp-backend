const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

const TEAM_MEMBERS = [
  { id: 1, name: 'Admin', username: 'admin', password: 'admin123', color: '#6C63FF', role: 'admin' },
  { id: 2, name: 'Rahim',  username: 'rahim',  password: 'rahim123',  color: '#00BFA6', role: 'agent' },
  { id: 3, name: 'Karim',  username: 'karim',  password: 'karim123',  color: '#FF6B6B', role: 'agent' },
  { id: 4, name: 'Mitu',   username: 'mitu',   password: 'mitu123',   color: '#FFB347', role: 'agent' },
  { id: 5, name: 'Sadia',  username: 'sadia',  password: 'sadia123',  color: '#4FC3F7', role: 'agent' },
  { id: 6, name: 'Hasan',  username: 'hasan',  password: 'hasan123',  color: '#AED581', role: 'agent' },
  { id: 7, name: 'Nadia',  username: 'nadia',  password: 'nadia123',  color: '#F48FB1', role: 'agent' },
];

let conversations = {};
let onlineAgents = {};
let waSocket = null;
let waStatus = 'disconnected';
let currentQR = null;

async function connectWhatsApp() {
  try {
    const authDir = '/tmp/auth_info';
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['WhatsApp Web', 'Chrome', '123.0.0'],
      generateHighQualityLinkPreview: false,
    });

    waSocket = sock;

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        currentQR = qr;
        waStatus = 'qr';
        try {
          const qrImage = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            width: 300,
            margin: 2,
          });
          io.emit('wa:qr', { qr, qrImage });
          io.emit('wa:status', { status: 'qr' });
          console.log('📱 QR ready!');
        } catch(e) {
          io.emit('wa:qr', { qr });
          io.emit('wa:status', { status: 'qr' });
        }
      }

      if (connection === 'open') {
        currentQR = null;
        waStatus = 'connected';
        const phone = sock.user?.id?.split(':')[0] || '';
        io.emit('wa:status', { status: 'connected', phone });
        console.log('✅ WhatsApp connected:', phone);
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode : undefined;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        waStatus = 'disconnected';
        waSocket = null;
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
          (msg.message?.imageMessage ? '[🖼️ Image]' : '') ||
          (msg.message?.audioMessage ? '[🎵 Audio]' : '') ||
          (msg.message?.videoMessage ? '[🎥 Video]' : '') ||
          '[Message]';

        const phone = jid.split('@')[0];

        if (!conversations[jid]) {
          conversations[jid] = {
            jid, phone,
            name: msg.pushName || phone,
            messages: [], assignedTo: null,
            unread: 0, lastActivity: Date.now()
          };
        }

        const msgObj = {
          id: msg.key.id, text,
          from: 'customer',
          time: (msg.messageTimestamp * 1000) || Date.now()
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
      }
    });

  } catch(err) {
    console.error('WA error:', err.message);
    setTimeout(connectWhatsApp, 5000);
  }
}

io.on('connection', (socket) => {
  socket.on('agent:login', ({ username, password }) => {
    const member = TEAM_MEMBERS.find(m => m.username === username && m.password === password);
    if (!member) {
      socket.emit('agent:login:error', { message: 'ভুল username বা password' });
      return;
    }
    onlineAgents[socket.id] = { ...member, socketId: socket.id };
    socket.emit('agent:login:success', { member });
    io.emit('agents:online', Object.values(onlineAgents));
    socket.emit('wa:status', { status: waStatus });
    socket.emit('conversations:all', Object.values(conversations).sort((a,b) => b.lastActivity - a.lastActivity));
    if (currentQR && waStatus === 'qr') {
      QRCode.toDataURL(currentQR, { width: 300, margin: 2 })
        .then(qrImage => socket.emit('wa:qr', { qr: currentQR, qrImage }))
        .catch(() => socket.emit('wa:qr', { qr: currentQR }));
    }
  });

  socket.on('wa:connect:new', () => {
    if (waSocket) {
      try { waSocket.end(); } catch(e) {}
      waSocket = null;
    }
    // auth মুছে নতুন QR আনো
    try {
      const authDir = '/tmp/auth_info';
      if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true });
      fs.mkdirSync(authDir);
    } catch(e) {}
    waStatus = 'disconnected';
    currentQR = null;
    connectWhatsApp();
  });

  socket.on('wa:disconnect', async () => {
    if (waSocket) {
      try { await waSocket.logout(); } catch(e) {}
      waSocket = null;
    }
    waStatus = 'disconnected';
    currentQR = null;
    try {
      const authDir = '/tmp/auth_info';
      if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true });
      fs.mkdirSync(authDir);
    } catch(e) {}
    io.emit('wa:status', { status: 'disconnected' });
  });

  socket.on('message:send', async ({ jid, text }) => {
    const agent = onlineAgents[socket.id];
    if (!agent || !waSocket || waStatus !== 'connected') {
      socket.emit('message:error', { error: 'WhatsApp connected নেই' });
      return;
    }
    try {
      await waSocket.sendMessage(jid, { text });
      const msgObj = {
        id: Date.now().toString(), text,
        from: 'agent', agentName: agent.name,
        agentColor: agent.color, time: Date.now()
      };
      if (conversations[jid]) {
        conversations[jid].messages.push(msgObj);
        conversations[jid].unread = 0;
        conversations[jid].lastActivity = Date.now();
      }
      io.emit('message:sent', { jid, message: msgObj });
    } catch (err) {
      socket.emit('message:error', { error: 'মেসেজ পাঠানো যায়নি' });
    }
  });

  socket.on('conversation:assign', ({ jid, agentId }) => {
    if (conversations[jid]) {
      conversations[jid].assignedTo = agentId;
      io.emit('conversation:assigned', { jid, agentId });
    }
  });

  socket.on('conversation:read', ({ jid }) => {
    if (conversations[jid]) {
      conversations[jid].unread = 0;
      io.emit('conversation:read', { jid });
    }
  });

  socket.on('disconnect', () => {
    const agent = onlineAgents[socket.id];
    if (agent) {
      delete onlineAgents[socket.id];
      io.emit('agents:online', Object.values(onlineAgents));
    }
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', wa: waStatus }));
app.get('/', (_, res) => res.json({ message: '✅ WhatsApp Team Inbox চালু!', wa: waStatus }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  connectWhatsApp();
});
