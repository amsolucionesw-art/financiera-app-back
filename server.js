import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

import sequelize from './models/sequelize.js';
import { initCuotasCron } from './cronJobs/cuotasCron.js';

dotenv.config();

/* ─── Modelos ─── */
import './models/Role.js';
import './models/Usuario.js';
import './models/Zona.js';
import './models/CobradorZona.js';
import './models/Cliente.js';
import './models/FormaPago.js';
import './models/associations.js';
import './models/Pago.js';
import './models/Credito.js';
import './models/Cuota.js';
import './models/Tarea_pendiente.js';
import './models/Presupuesto.js';
import './models/CajaMovimiento.js';
import './models/Compra.js';
import './models/Gasto.js';
import './models/VentaManual.js';
import './models/Proveedor.js';

/* ───────────────── Helpers ───────────────── */

const normalizePrefix = (p) => {
  if (p == null) return '/api';
  const s = String(p).trim();
  if (s === '') return ''; // permite “sin prefijo” si lo quieren
  return s.startsWith('/') ? s : `/${s}`;
};

const parseBool = (v, def = false) => {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return def;
};

const parseCorsOrigins = (raw) => {
  if (!raw) return null; // null => usa CORS “abierto” (no recomendado en prod)
  const s = String(raw).trim();
  if (!s) return null;
  if (s === '*' || s.toLowerCase() === 'all') return '*';
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
};

const API_PREFIX = normalizePrefix(process.env.API_PREFIX || '/api');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const JSON_LIMIT = process.env.JSON_LIMIT || '2mb';
const TRUST_PROXY = parseBool(process.env.TRUST_PROXY, false);

const CORS_ORIGIN = parseCorsOrigins(process.env.CORS_ORIGIN);
const CORS_CREDENTIALS = parseBool(process.env.CORS_CREDENTIALS, false);

/**
 * ⚠️ En producción REAL, no conviene sync alter. En staging local puede servir.
 * - DB_SYNC=true => hace sequelize.sync()
 * - DB_SYNC_ALTER=true => hace sequelize.sync({ alter: true })
 */
const DB_SYNC = parseBool(process.env.DB_SYNC, false);
const DB_SYNC_ALTER = parseBool(process.env.DB_SYNC_ALTER, false);

/* ─── App ─── */
const app = express();

app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);

/* ─── Middlewares ─── */
app.use(
  cors({
    origin:
      CORS_ORIGIN === '*'
        ? '*'
        : CORS_ORIGIN
          ? CORS_ORIGIN
          : true, // si no se define, permite el origen del request (staging cómodo)
    credentials: CORS_CREDENTIALS,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: true }));

/* ─── Archivos estáticos (fuera del prefijo) ─── */
const uploadsDir = path.resolve(process.cwd(), 'uploads');
app.use('/uploads', express.static(uploadsDir));

/* ─── Healthchecks ─── */
app.get('/', (_req, res) => res.send('API OK'));

app.get(`${API_PREFIX}/health`, (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    apiPrefix: API_PREFIX,
  });
});

// “Ready” chequea DB (útil para staging/prod)
app.get(`${API_PREFIX}/ready`, async (_req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(503).json({ ok: false, db: false, error: 'DB_NOT_READY' });
  }
});

/* ─── Rutas ─── */
import clientesRoutes from './routes/clientes.routes.js';
import usuariosRoutes from './routes/usuarios.routes.js';
import authRoutes from './routes/auth.routes.js';
import zonasRoutes from './routes/zonas.routes.js';
import creditosRoutes from './routes/creditos.routes.js';
import formasPagoRoutes from './routes/formasPago.routes.js';
import rolesRoutes from './routes/roles.routes.js';
import pagosRoutes from './routes/pagos.routes.js';
import cuotasRoutes from './routes/cuotas.routes.js';
import informesRoutes from './routes/informes.routes.js';
import tareasRoutes from './routes/tareas.routes.js';
import presupuestoRoutes from './routes/presupuesto.routes.js';
import recibosRoutes from './routes/recibos.routes.js';
import cajaRoutes from './routes/caja.routes.js';
import comprasRoutes from './routes/compras.routes.js';
import gastosRoutes from './routes/gastos.routes.js';
import ventasRoutes from './routes/ventas.routes.js';
import exportacionesRoutes from './routes/exportaciones.routes.js';
import proveedoresRoutes from './routes/proveedores.routes.js';

app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/usuarios`, usuariosRoutes);
app.use(`${API_PREFIX}/clientes`, clientesRoutes);
app.use(`${API_PREFIX}/zonas`, zonasRoutes);
app.use(`${API_PREFIX}/creditos`, creditosRoutes);
app.use(`${API_PREFIX}/formas-pago`, formasPagoRoutes);
app.use(`${API_PREFIX}/roles`, rolesRoutes);
app.use(`${API_PREFIX}/pagos`, pagosRoutes);
app.use(`${API_PREFIX}/cuotas`, cuotasRoutes);
app.use(`${API_PREFIX}/informes`, informesRoutes);
app.use(`${API_PREFIX}/tareas`, tareasRoutes);
app.use(`${API_PREFIX}/presupuestos`, presupuestoRoutes);
app.use(`${API_PREFIX}/recibos`, recibosRoutes);
app.use(`${API_PREFIX}/caja`, cajaRoutes);
app.use(`${API_PREFIX}/compras`, comprasRoutes);
app.use(`${API_PREFIX}/gastos`, gastosRoutes);
app.use(`${API_PREFIX}/ventas`, ventasRoutes);
app.use(`${API_PREFIX}/exportaciones`, exportacionesRoutes);
app.use(`${API_PREFIX}/proveedores`, proveedoresRoutes);

/* ─── Start/Stop controlado ─── */
let server = null;

const start = async () => {
  try {
    // 1) DB
    await sequelize.authenticate();
    console.log('🟢 Conectado a PostgreSQL');

    if (DB_SYNC || DB_SYNC_ALTER) {
      const syncOpts = DB_SYNC_ALTER ? { alter: true } : {};
      await sequelize.sync(syncOpts);
      console.log(`🗂️ Modelos sincronizados con PostgreSQL${DB_SYNC_ALTER ? ' (alter)' : ''}`);
    } else {
      console.log('ℹ️ Sync deshabilitado (DB_SYNC=false).');
    }

    // 2) Cron (una sola vez, con DB lista)
    initCuotasCron();
    console.log('⏱️ Cron de cuotas inicializado');

    // 3) Server
    server = app.listen(PORT, HOST, () => {
      console.log(`🚀 Servidor corriendo en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      console.log(`🔗 Prefix API: ${API_PREFIX || '(sin prefijo)'}`);
      console.log(`📁 Static uploads: ${uploadsDir}`);
    });
  } catch (err) {
    console.error('🔴 Error al iniciar el servidor:', err);
    process.exit(1);
  }
};

const shutdown = async (signal) => {
  try {
    console.log(`\n🧯 Recibido ${signal}. Cerrando...`);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log('🛑 HTTP server cerrado');
    }
    await sequelize.close();
    console.log('🔌 Conexión DB cerrada');
    process.exit(0);
  } catch (e) {
    console.error('⚠️ Error durante el cierre:', e);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();

export default app;