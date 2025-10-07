// backend/src/app.js  (o server.js, según tu estructura)

import express from 'express';
import cors from 'cors';
import sequelize from './models/sequelize.js';
import dotenv from 'dotenv';
import path from 'path';

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
import './models/CajaMovimiento.js'; // ⬅️ Caja
import './models/Compra.js';         // ⬅️ Compras
import './models/Gasto.js';          // ⬅️ Gastos
import './models/VentaManual.js';    // ⬅️ Ventas manuales
import './models/Proveedor.js';      // ⬅️ Proveedores (nuevo)

/* ─── Conexión a la base ─── */
sequelize.authenticate()
  .then(() => console.log('🟢 Conectado a PostgreSQL'))
  .catch(err => console.error('🔴 Error al conectar PostgreSQL:', err));

sequelize.sync({ alter: true })
  .then(() => console.log('🗂️ Modelos sincronizados con PostgreSQL'))
  .catch(err => console.error('🔴 Error al sincronizar modelos:', err));

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
import cajaRoutes from './routes/caja.routes.js';                 // Caja
import comprasRoutes from './routes/compras.routes.js';           // ⬅️ Compras
import gastosRoutes from './routes/gastos.routes.js';             // ⬅️ Gastos
import ventasRoutes from './routes/ventas.routes.js';             // ⬅️ Ventas manuales
import exportacionesRoutes from './routes/exportaciones.routes.js'; // ⬅️ Exportaciones
import proveedoresRoutes from './routes/proveedores.routes.js';   // ⬅️ Proveedores (nuevo)

/* ─── App ─── */
const app = express();

/* ─── Middlewares ─── */
app.use(cors());
app.use(express.json());

/* ─── Cron (inicializar una sola vez) ─── */
initCuotasCron();

/* ─── Prefijo API unificado ─── */
const API_PREFIX = process.env.API_PREFIX || '/api';

/* ─── Montaje de rutas con /api ─── */
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
app.use(`${API_PREFIX}/proveedores`, proveedoresRoutes); // ⬅️ Proveedores (nuevo)

/* ─── Archivos estáticos (fuera del prefijo) ─── */
app.use('/uploads', express.static(path.resolve('uploads')));

/* ─── Healthchecks útiles ─── */
app.get('/', (_req, res) => res.send('API OK'));
app.get(`${API_PREFIX}/health`, (_req, res) => res.json({ ok: true }));

/* ─── Inicio del servidor ─── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Prefix API: ${API_PREFIX}`);
});

export default app;