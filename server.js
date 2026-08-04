const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');

// ------------------------------
//  CONFIG – REPLACE WITH YOUR REAL PROJECT ID
// ------------------------------
const FIREBASE_PROJECT_ID = 'cleansweepsg-f6340';   // ← CHANGE THIS

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------
// FIREBASE ADMIN SETUP (manual credential via GoogleAuth)
// ------------------------------
let firebaseApp = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });

    firebaseApp = admin.initializeApp({
      credential: {
        getAccessToken: () => auth.getAccessToken(),
      },
      projectId: serviceAccount.project_id || FIREBASE_PROJECT_ID,
    });
    console.log('🔥 Firebase Admin initialized (manual credential)');
  } catch (e) {
    console.error('❌ Firebase Admin init error:', e);
  }
}

// ------------------------------
// MIDDLEWARE
// ------------------------------
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Create required directories
['data', 'public/uploads'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Data files
const REPORTS_FILE = path.join(__dirname, 'data', 'reports.json');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const SPONSOR_STATS_FILE = path.join(__dirname, 'data', 'sponsorStats.json');

// Expiry constants (still defined but not used automatically)
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
const CLEANED_DELAY = 24 * 60 * 60 * 1000;

// ------------------------------
// HELPERS
// ------------------------------
const getData = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
const saveData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));


function cleanReports(reports) {
  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const oneDay = 24 * 60 * 60 * 1000;

  return reports.filter(r => {
    // Keep legacy reports that have no timestamp
    if (!r.timestamp) return true;

    // If a report is cleaned and its deletionTime has passed, remove it
    if (r.cleaned && r.deletionTime && now > r.deletionTime) {
      console.log('[CLEANED] Removing report ' + r.id + ' - 24h after cleaning');
      return false;
    }

    // If a report is not cleaned and older than 7 days, remove it
    if (!r.cleaned && (now - r.timestamp > oneWeek)) {
      const ageDays = Math.round((now - r.timestamp) / oneDay);
      console.log('[OLD] Removing report ' + r.id + ' - age ' + ageDays + ' days');
      return false;
    }

    return true;
  });
}

// ------------------------------
// AUTH MIDDLEWARE (Firebase REST verification)
// ------------------------------
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized' });

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error('Missing FIREBASE_API_KEY');

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    req.user = data.users[0];   // contains localId, email, etc.
    next();
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ------------------------------
// PUSH NOTIFICATION HELPERS
// ------------------------------
async function getAccessToken() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null;
  const auth = new GoogleAuth({
    credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

async function sendPushNotification(fcmToken, title, body, dataPayload = {}) {
  if (!fcmToken) return;
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error('No access token');

    const message = {
      message: {
        token: fcmToken,
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(dataPayload).map(([k, v]) => [k, String(v)])
        ),
      },
    };

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify(message),
      }
    );
    const result = await res.json();
    if (!res.ok) console.error('FCM error:', result);
    else console.log('Push sent to', fcmToken);
  } catch (err) {
    console.error('Push send error:', err);
  }
}

// ------------------------------
// BREVO EMAIL NOTIFICATION FUNCTION
// ------------------------------
async function sendEmailNotification(subject, text) {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    console.warn('Brevo API key missing, skipping email');
    return;
  }

  const payload = {
    sender: {
      name: 'CleanSweep SG',
      email: process.env.BREVO_SENDER_EMAIL || 'noreply@cleansweep.sg'
    },
    to: [{
      email: 'groqclaw@gmail.com',   // ← change to real NEA email later
      name: 'NEA Officer'
    }],
    subject: subject,
    textContent: text
  };

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log('Email sent via Brevo');
    } else {
      const errorData = await response.json();
      console.error('Brevo email error:', errorData);
    }
  } catch (err) {
    console.error('Email send error:', err);
  }
}

// ------------------------------
// MULTER CONFIG
// ------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ==============================
// ROUTES
// ==============================

app.get('/ping', (req, res) => res.send('pong'));

// ----- User Profile -----
app.get('/api/user', authMiddleware, (req, res) => {
  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  res.json({ nickname: user ? user.nickname : null });
});

app.put('/api/user/token', authMiddleware, (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ error: 'fcmToken required' });
  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.fcmToken = fcmToken;
  saveData(USERS_FILE, users);
  res.json({ success: true });
});

// ----- Nickname Registration -----
app.post('/api/users', authMiddleware, (req, res) => {
  const { nickname } = req.body;
  if (!nickname || !nickname.trim()) return res.status(400).json({ error: 'Nickname required' });
  const uid = req.user.localId;
  let users = getData(USERS_FILE);
  if (users.some(u => u.nickname === nickname.trim() && u.uid !== uid))
    return res.status(409).json({ error: 'Nickname already taken' });

  
const existing = users.find(u => u.uid === uid);
if (existing) {
  return res.status(409).json({ error: 'Nickname already set and cannot be changed.' });
} else {
  users.push({ uid, nickname: nickname.trim() });
}

// ----- Reports -----
app.post('/api/reports', authMiddleware, upload.single('photo'), (req, res) => {
  const { lat, lng, address, time } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  const nickname = user ? user.nickname : 'Anonymous';

  const imageUrl = `/uploads/${req.file.filename}`;
  const newReport = {
    id: uuidv4(),
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    imageUrl,
    address: address || 'Unknown',
    time: time || new Date().toLocaleString(),
    userId: uid,
    userName: nickname,
    comments: [],
    timestamp: Date.now(),
  };

  const reports = getData(REPORTS_FILE);
  reports.push(newReport);
  saveData(REPORTS_FILE, reports);

  // --- Send email notification about the new report ---
  const emailSubject = `New trash report by ${nickname}`;
  const emailBody = `A new trash location was reported:

    Address: ${address || 'Unknown'}
    User: ${nickname}
    Time: ${time || new Date().toLocaleString()}
    Coordinates: ${lat}, ${lng}
    Photo: https://cleansweep-backend.onrender.com${imageUrl}`;

  sendEmailNotification(emailSubject, emailBody);

  res.status(201).json(newReport);
});

app.get('/api/reports', (req, res) => {
  let reports = getData(REPORTS_FILE);
  reports = cleanReports(reports);
  // Save the cleaned list back – this is the only place where auto‑deletion happens
  saveData(REPORTS_FILE, reports);
  res.json(reports);
});

// ----- Comments (with notification) -----
app.post('/api/reports/:id/comments', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Comment text required' });

  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  const author = user ? user.nickname : 'Anonymous';

  const reports = getData(REPORTS_FILE);
  const report = reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  report.comments.push({ author, text, timestamp: Date.now() });
  saveData(REPORTS_FILE, reports);

  // Notify report owner (if not the same user)
  const owner = users.find(u => u.uid === report.userId);
  if (owner && owner.fcmToken && owner.uid !== uid) {
    const notifTitle = `New comment on your report`;
    const notifBody = `${author} commented: ${text}`;
    sendPushNotification(owner.fcmToken, notifTitle, notifBody, { reportId: id });
  }

  res.json(report);
});

// ----- Mark as Cleaned (with notification) -----
app.post('/api/reports/:id/cleaned', authMiddleware, upload.single('photo'), (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  const nickname = user ? user.nickname : 'Anonymous';

  const reports = getData(REPORTS_FILE);
  const report = reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  report.cleaned = {
    imageUrl: `/uploads/${req.file.filename}`,
    userName: nickname,
    timestamp: Date.now(),
  };
  report.deletionTime = Date.now() + CLEANED_DELAY;   // still set, but won't be used until cleanReports is re-enabled
  saveData(REPORTS_FILE, reports);

  // Notify original reporter
  const reporter = users.find(u => u.uid === report.userId);
  if (reporter && reporter.fcmToken) {
    const notifTitle = 'Your report was cleaned!';
    const notifBody = `${nickname} marked the trash at ${report.address || 'the location'} as cleaned.`;
    sendPushNotification(reporter.fcmToken, notifTitle, notifBody, { reportId: id });
  }

  res.json(report);
});

// ----- Sponsor Stats -----
function getSponsorStats() {
  if (!fs.existsSync(SPONSOR_STATS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SPONSOR_STATS_FILE, 'utf-8'));
}

function saveSponsorStats(stats) {
  fs.writeFileSync(SPONSOR_STATS_FILE, JSON.stringify(stats, null, 2));
}

app.post('/api/sponsors/view', (req, res) => {
  const { sponsorId } = req.body;
  if (!sponsorId) return res.status(400).json({ error: 'sponsorId required' });
  const stats = getSponsorStats();
  if (!stats[sponsorId]) stats[sponsorId] = { views: 0, clicks: 0 };
  stats[sponsorId].views++;
  saveSponsorStats(stats);
  res.json({ success: true });
});

app.post('/api/sponsors/click', (req, res) => {
  const { sponsorId } = req.body;
  if (!sponsorId) return res.status(400).json({ error: 'sponsorId required' });
  const stats = getSponsorStats();
  if (!stats[sponsorId]) stats[sponsorId] = { views: 0, clicks: 0 };
  stats[sponsorId].clicks++;
  saveSponsorStats(stats);
  res.json({ success: true });
});

app.get('/api/sponsors/stats', (req, res) => {
  res.json(getSponsorStats());
});

// ==============================
// START SERVER
// ==============================

// ----- Report user or photo -----
app.post('/api/report', authMiddleware, async (req, res) => {
  const { type, reportId, reportedUserName, imageUrl } = req.body;
  if (!type || !reportId) return res.status(400).json({ error: 'Missing report details' });

  const uid = req.user.localId || req.user.uid;
  const users = getData(USERS_FILE);
  const reporter = users.find(u => u.uid === uid);
  const reporterNickname = reporter ? reporter.nickname : 'Anonymous';

  let subject, body;
  if (type === 'user') {
    subject = 'User Report: ' + reportedUserName;
    body = 'User ' + reporterNickname + ' reported user: ' + reportedUserName + '\nReport ID: ' + reportId;
  } else {
    subject = 'Photo Report: Report ID ' + reportId;
    body = 'User ' + reporterNickname + ' reported this photo:\n' + imageUrl;
  }

  await sendEmailNotification(subject, body);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`CleanSweep backend running on port ${PORT}`);
  // Initial cleanup (disabled)
  let reports = getData(REPORTS_FILE);
  reports = cleanReports(reports);
  saveData(REPORTS_FILE, reports);   // this will write back the same reports unchanged
});
