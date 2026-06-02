const fs   = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const dbPath  = path.join(dataDir, 'db.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dbPath))  fs.writeFileSync(dbPath, JSON.stringify({ users: {}, keys: {} }, null, 2));

function readDB() {
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

module.exports = {
  getUser(discordId) {
    return readDB().users[discordId] ?? null;
  },
  upsertUser(discordId, username, avatar) {
    const data = readDB();
    data.users[discordId] = {
      discord_id:  discordId,
      username,
      avatar,
      role:        data.users[discordId]?.role ?? 'member',
      created_at:  data.users[discordId]?.created_at ?? Math.floor(Date.now() / 1000),
    };
    writeDB(data);
  },
  setUserRole(discordId, role) {
    const data = readDB();
    if (data.users[discordId]) { data.users[discordId].role = role; writeDB(data); }
  },
  getKey(keyValue) {
    return readDB().keys[keyValue] ?? null;
  },
  getKeyBySession(sessionId) {
    return Object.values(readDB().keys).find(k => k.stripe_session_id === sessionId) ?? null;
  },
  insertKey(keyValue, plan, sessionId, email) {
    const data = readDB();
    if (!data.keys[keyValue]) {
      data.keys[keyValue] = {
        key_value: keyValue, discord_id: null, active: false,
        plan, stripe_session_id: sessionId, customer_email: email,
        created_at: Math.floor(Date.now() / 1000),
      };
      writeDB(data);
    }
  },
  linkKey(keyValue, discordId) {
    const data = readDB();
    if (data.keys[keyValue]) { data.keys[keyValue].discord_id = discordId; writeDB(data); }
  },
  getUserKeys(discordId) {
    return Object.values(readDB().keys)
      .filter(k => k.discord_id === discordId && k.active)
      .sort((a, b) => b.created_at - a.created_at);
  },
  activateKey(keyValue) {
    const data = readDB();
    if (data.keys[keyValue]) { data.keys[keyValue].active = true; writeDB(data); }
  },
  deactivateKey(keyValue) {
    const data = readDB();
    if (data.keys[keyValue]) { data.keys[keyValue].active = false; writeDB(data); }
  },
  removeLinkedKey(discordId, keyValue) {
    // Remove from local db entirely
    const data = readDB();
    delete data.keys[keyValue];
    writeDB(data);
    // Also prune from CF async (fire and forget via server)
  },
};
