import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_KEYLEN = 64;

function hashPassword(plaintext) {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

const zylosDir = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');
const configPath = path.join(dataDir, 'config.json');

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'spool'), { recursive: true });

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {}

config.host = process.env.DASHBOARD_HOST || config.host || '0.0.0.0';
config.port = Number(process.env.DASHBOARD_PORT || config.port || 3470);
config.auth = {
  ...(config.auth || {}),
  enabled: process.env.DASHBOARD_AUTH_ENABLED === 'false'
    ? false
    : config.auth?.enabled !== false,
};

if (!config.auth.password) {
  const plaintext = process.env.DASHBOARD_PASSWORD || crypto.randomBytes(16).toString('hex');
  config.auth.password = hashPassword(plaintext);
  if (!process.env.DASHBOARD_PASSWORD) {
    console.log(`Dashboard password: ${plaintext}`);
  }
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
