import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

/**
 * Candado:
 * - Elegimos explícitamente qué archivo de entorno cargar con ENV_FILE
 * - Forzamos override por si algún módulo cargó otro .env antes
 */
const ENV_FILE = process.env.ENV_FILE || '.env';
dotenv.config({
  path: path.resolve(process.cwd(), ENV_FILE),
  override: true,
});

/* ─── Helpers ─── */

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
  if (!raw) return null;
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

const DB_SYNC = parseBool(process.env.DB_SYNC, false);
const DB_SYNC_ALTER = parseBool(process.env.DB_SYNC_ALTER, false);

const UPLOADS_PUBLIC_ENABLED = parseBool(process.env.UPLOADS_PUBLIC_ENABLED, false);

/**
 * Importante:
 * - Todos los imports locales se hacen DESPUÉS del dotenv
 *   para que sequelize y los modelos tomen el ENV correcto.
 */
const { default: sequelize } = await import('./models/sequelize.js');
const { initCuotasCron } = await import('./cronJobs/cuotasCron.js');

/* ─── Modelos ─── */
await import('./models/Role.js');
await import('./models/Usuario.js');
await import('./models/Zona.js');
await import('./models/CobradorZona.js');
await import('./models/Cliente.js');
await import('./models/FormaPago.js');
await import('./models/associations.js');
await import('./models/Pago.js');
await import('./models/Credito.js');
await import('./models/Cuota.js');
await import('./models/Tarea_pendiente.js');
await import('./models/Presupuesto.js');
await import('./models/CajaMovimiento.js');
await import('./models/Compra.js');
await import('./models/Gasto.js');
await import('./models/VentaManual.js');
await import('./models/Proveedor.js');

/* ─── Rutas ─── */
const { default: clientesRoutes } = await import('./routes/clientes.routes.js');
const { default: usuariosRoutes } = await import('./routes/usuarios.routes.js');
const { default: authRoutes } = await import('./routes/auth.routes.js');
const { default: zonasRoutes } = await import('./routes/zonas.routes.js');
const { default: creditosRoutes } = await import('./routes/creditos.routes.js');
const { default: formasPagoRoutes } = await import('./routes/formasPago.routes.js');
const { default: rolesRoutes } = await import('./routes/roles.routes.js');
const { default: pagosRoutes } = await import('./routes/pagos.routes.js');
const { default: cuotasRoutes } = await import('./routes/cuotas.routes.js');
const { default: informesRoutes } = await import('./routes/informes.routes.js');
const { default: tareasRoutes } = await import('./routes/tareas.routes.js');
const { default: presupuestoRoutes } = await import('./routes/presupuesto.routes.js');
const { default: recibosRoutes } = await import('./routes/recibos.routes.js');
const { default: cajaRoutes } = await import('./routes/caja.routes.js');
const { default: comprasRoutes } = await import('./routes/compras.routes.js');
const { default: gastosRoutes } = await import('./routes/gastos.routes.js');
const { default: ventasRoutes } = await import('./routes/ventas.routes.js');
const { default: exportacionesRoutes } = await import('./routes/exportaciones.routes.js');
const { default: proveedoresRoutes } = await import('./routes/proveedores.routes.js');

/* ─── App ─── */
const app = express();

app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);

/* ─── Middlewares ─── */

/**
 * ✅ FIX CORS (PDF / preflight) — versión correcta:
 * Problema que viste:
 * - El preflight te devuelve Access-Control-Allow-Origin: *
 * - El browser rechaza eso cuando la request se hace con credenciales (Authorization / include)
 *
 * Solución:
 * - NO devolver "*" cuando CORS_CREDENTIALS=true.
 * - Si CORS_ORIGIN='*' y credentials=true => reflejar el Origin entrante (devolver origin exacto).
 * - Si CORS_ORIGIN es lista => permitir solo esa lista.
 * - Si no hay CORS_ORIGIN configurado => permitir y reflejar (seguro para credentials).
 */
const corsOriginHandler = (origin, cb) => {
  // Requests sin Origin (curl/server-to-server): permitir
  if (!origin) return cb(null, true);

  // Sin configuración: permitir (con credentials reflejamos origin)
  if (!CORS_ORIGIN) {
    return cb(null, CORS_CREDENTIALS ? origin : true);
  }

  // Env pide "*"
  if (CORS_ORIGIN === '*') {
    // Con credenciales, '*' rompe el navegador => reflejar origin
    return cb(null, CORS_CREDENTIALS ? origin : '*');
  }

  // Allowlist
  const allowed = Array.isArray(CORS_ORIGIN) ? CORS_ORIGIN : [CORS_ORIGIN];
  if (allowed.includes(origin)) return cb(null, origin);

  // Bloqueado
  return cb(new Error(`CORS bloqueado para origin: ${origin}`));
};

app.use(
  cors({
    origin: corsOriginHandler,
    credentials: CORS_CREDENTIALS,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // útil para downloads cuando el back setea Content-Disposition
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400,
    optionsSuccessStatus: 204,
  })
);

app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: true }));

/* ─── Archivos estáticos ─── */
const uploadsDir = path.resolve(process.cwd(), 'uploads');

if (UPLOADS_PUBLIC_ENABLED) {
  app.use('/uploads', express.static(uploadsDir));
} else {
  app.use('/uploads', (_req, res) => {
    res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  });
}

/* ─── Healthchecks ─── */
app.get('/', (_req, res) => res.send('API OK'));

app.get(`${API_PREFIX}/health`, (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    apiPrefix: API_PREFIX,
    uploadsPublic: UPLOADS_PUBLIC_ENABLED,
  });
});

app.get(`${API_PREFIX}/ready`, async (_req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ ok: true, db: true });
  } catch (_e) {
    res.status(503).json({ ok: false, db: false, error: 'DB_NOT_READY' });
  }
});

/* ─── Routes ─── */
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

/* ─── Start/Stop ─── */
let server = null;

const start = async () => {
  try {
    console.log(`🧩 ENV_FILE: ${ENV_FILE}`);
    console.log(
      `🗄️ DB target: host=${process.env.DB_HOST || '(unset)'} port=${process.env.DB_PORT || '(unset)'} db=${process.env.DB_NAME || '(unset)'} user=${process.env.DB_USER || '(unset)'}`
    );

    console.log(`🌐 CORS_ORIGIN env: ${process.env.CORS_ORIGIN || '(unset)'}`);
    console.log(`🍪 CORS_CREDENTIALS: ${CORS_CREDENTIALS ? 'true' : 'false'}`);
    console.log(`🌐 CORS_ORIGIN parseado: ${JSON.stringify(CORS_ORIGIN)}`);

    await sequelize.authenticate();
    console.log('🟢 Conectado a PostgreSQL');

    if (DB_SYNC || DB_SYNC_ALTER) {
      const syncOpts = DB_SYNC_ALTER ? { alter: true } : {};
      await sequelize.sync(syncOpts);
      console.log(`🗂️ Modelos sincronizados con PostgreSQL${DB_SYNC_ALTER ? ' (alter)' : ''}`);
    } else {
      console.log('ℹ️ Sync deshabilitado (DB_SYNC=false).');
    }

    initCuotasCron();
    console.log('⏱️ Cron de cuotas inicializado');

    server = app.listen(PORT, HOST, () => {
      console.log(`🚀 Servidor corriendo en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      console.log(`🔗 Prefix API: ${API_PREFIX || '(sin prefijo)'}`);
      console.log(`📁 Static uploads: ${uploadsDir}`);
      console.log(`🧱 Uploads public: ${UPLOADS_PUBLIC_ENABLED ? 'ON' : 'OFF'}`);
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