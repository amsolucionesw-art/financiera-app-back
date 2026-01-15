// models/sequelize.js
import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

/* ───────────────── Helpers ───────────────── */
const parseBool = (v, def = false) => {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return def;
};

const toInt = (v, def) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
};

/* ───────────────── Config ───────────────── */

// Logging (por defecto OFF)
const SEQUELIZE_LOGGING = parseBool(process.env.SEQUELIZE_LOGGING, false);
const logging = SEQUELIZE_LOGGING ? console.log : false;

// SSL opcional (activar sólo si lo piden)
const DB_SSL = parseBool(process.env.DB_SSL, false);
// En algunos entornos con SSL, se necesita rejectUnauthorized=false
const DB_SSL_REJECT_UNAUTHORIZED = parseBool(process.env.DB_SSL_REJECT_UNAUTHORIZED, false);

// Pool configurable (valores razonables por defecto)
const pool = {
  max: toInt(process.env.DB_POOL_MAX, 10),
  min: toInt(process.env.DB_POOL_MIN, 0),
  acquire: toInt(process.env.DB_POOL_ACQUIRE, 30000),
  idle: toInt(process.env.DB_POOL_IDLE, 10000),
};

const baseOptions = {
  dialect: 'postgres',
  logging,
  pool,
};

// Dialect options (SSL)
if (DB_SSL) {
  baseOptions.dialectOptions = {
    ssl: {
      require: true,
      rejectUnauthorized: DB_SSL_REJECT_UNAUTHORIZED,
    },
  };
}

/* ───────────────── Inicialización ───────────────── */

// Prioridad 1: DATABASE_URL (ideal para prod/staging)
let sequelize;
if (process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim() !== '') {
  sequelize = new Sequelize(process.env.DATABASE_URL, baseOptions);
} else {
  // Fallback clásico por variables separadas
  const DB_NAME = process.env.DB_NAME;
  const DB_USER = process.env.DB_USER;
  const DB_PASSWORD = process.env.DB_PASSWORD;
  const DB_HOST = process.env.DB_HOST || 'localhost';
  const DB_PORT = toInt(process.env.DB_PORT, 5432);

  sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
    ...baseOptions,
    host: DB_HOST,
    port: DB_PORT,
  });
}

export default sequelize;

