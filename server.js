const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const https = require('https');  // or node-fetch if preferred, but using built-in

// ---- Send push notification via FCM HTTP v1 (using Web API Key) ----
async function sendPushNotification(fcmToken, title, body, dataPayload = {}) {
  if (!fcmToken || !process.env.FIREBASE_API_KEY) return;

  const message = {
    message: {
      token: fcmToken,
      notification: { title, body },
      data: dataPayload   // contains reportId for deep linking
    }
  };

  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/cleansweepsg-f6340/messages:send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await getAccessToken()}`
        },
        body: JSON.stringify(message)
      }
    );
    const result = await response.json();
    if (response.ok) console.log('Push sent');
    else console.error('FCM error:', result);
  } catch (err) {
    console.error('Failed to send push:', err);
  }
}

// Helper to get OAuth2 access token using the service account (still needed for FCM v1)
async function getAccessToken() {
  const { GoogleAuth } = require('google-auth-library');
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null;
  const auth = new GoogleAuth({
    credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/firebase.messaging']
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

// ---- VERIFY FIREBASE TOKEN (REST call, no admin SDK) ----
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

async function verifyIdToken(idToken) {
  if (!FIREBASE_API_KEY) throw new Error('Missing FIREBASE_API_KEY');
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`;
  const body = JSON.stringify({ idToken });

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message));
          } else {
            // The user info is in json.users[0]
            resolve(json.users[0]);
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- AUTH MIDDLEWARE (uses REST verification) ----
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const userInfo = await verifyIdToken(idToken);
    req.user = userInfo;   // contains uid, email, etc.
    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---- MULTER ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage });

// ========== ROUTES ==========

app.get('/ping', (req, res) => res.send('pong'));

app.get('/api/user', authMiddleware, (req, res) => {
  const uid = req.user.localId;  // 'localId' is the UID in the REST response
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  res.json({ nickname: user ? user.nickname : null });
});
// --- Update FCM token for current user ---
app.put('/api/user/token', authMiddleware, (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ error: 'fcmToken required' });
  const uid = req.user.localId || req.user.uid;
  let users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  if (user) {
    user.fcmToken = fcmToken;
    saveData(USERS_FILE, users);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});
// --- Update FCM token for current user ---
app.put('/api/user/token', authMiddleware, (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ error: 'fcmToken required' });
  const uid = req.user.localId || req.user.uid;
  let users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  if (user) {
    user.fcmToken = fcmToken;
    saveData(USERS_FILE, users);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.post('/api/users', authMiddleware, (req, res) => {
  const { nickname } = req.body;
  if (!nickname || nickname.trim().length === 0) {
    return res.status(400).json({ error: 'Nickname required' });
  }
  const uid = req.user.localId;
  let users = getData(USERS_FILE);
  if (users.some(u => u.nickname === nickname.trim() && u.uid !== uid)) {
    return res.status(409).json({ error: 'Nickname already taken' });
  }
  const existingUser = users.find(u => u.uid === uid);
  if (existingUser) {
    existingUser.nickname = nickname.trim();
  } else {
    users.push({ uid, nickname: nickname.trim() });
  }
  saveData(USERS_FILE, users);
  res.json({ success: true, nickname: nickname.trim() });
});

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
    timestamp: Date.now()
  };

  const reports = getData(REPORTS_FILE);
  reports.push(newReport);
  saveData(REPORTS_FILE, reports);
  res.status(201).json(newReport);
});

app.post('/api/reports/:id/comments', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  const uid = req.user.localId;
  const users = getData(USERS_FILE);
  const user = users.find(u => u.uid === uid);
  const author = user ? user.nickname : 'Anonymous';

  const reports = getData(REPORTS_FILE);
  const report = reports.find(r => r.id === id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  report.comments.push({ author, text, timestamp: Date.now() });
  saveData(REPORTS_FILE, reports);

  // --- Notify report owner about new comment ---
  const reportOwnerId = report.userId;
  const users = getData(USERS_FILE);
  const owner = users.find(u => u.uid === reportOwnerId);
  if (owner && owner.fcmToken && owner.uid !== uid) {  // don't notify if commenter is owner
    const notifTitle = 'New comment on your report';
    const notifBody = ${author} commented: ${text};
    sendPushNotification(owner.fcmToken, notifTitle, notifBody, { reportId: id });
  }
  
  res.json(report);
});

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
    timestamp: Date.now()
  };
  report.deletionTime = Date.now() + CLEANED_DELAY;
  saveData(REPORTS_FILE, reports);

// --- Notify original reporter ---
  const originalReporterId = report.userId;
  const users = getData(USERS_FILE);
  const reporter = users.find(u => u.uid === originalReporterId);
  if (reporter && reporter.fcmToken) {
    const notifTitle = 'Your report was cleaned!';
    const notifBody = ${nickname} marked the trash at ${report.address || 'the location'} as cleaned.;
    sendPushNotification(reporter.fcmToken, notifTitle, notifBody, { reportId: id });
  }
  
  // --- Notify the original reporter ---
  const originalReporterId = report.userId;
  const users = getData(USERS_FILE);
  const reporter = users.find(u => u.uid === originalReporterId);
  if (reporter && reporter.fcmToken) {
    const notifTitle = 'Your report was cleaned!';
    const notifBody = ${nickname} marked the trash at ${report.address || 'the location'} as cleaned.;
    sendPushNotification(reporter.fcmToken, notifTitle, notifBody);
  }
  res.json(report);
});

app.get('/api/reports', (req, res) => {
  let reports = getData(REPORTS_FILE);
  const cleanedReports = cleanReports(reports);
  if (cleanedReports.length !== reports.length) {
    saveData(REPORTS_FILE, cleanedReports);
  }
  res.json(cleanedReports);
});

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`CleanSweep backend running on http://localhost:${PORT}`);
  let reports = getData(REPORTS_FILE);
  const cleaned = cleanReports(reports);
  if (cleaned.length !== reports.length) {
    saveData(REPORTS_FILE, cleaned);
    console.log(`Cleaned up ${reports.length - cleaned.length} old reports`);
  }
});
