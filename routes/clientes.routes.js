// backend/src/routes/clientes.routes.js
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
  crearCliente,
  obtenerClientes,
  obtenerClientesBasico,
  obtenerClientePorId,
  actualizarCliente,
  eliminarCliente,
  obtenerClientesPorCobrador,
  importarClientesDesdePlanilla
} from '../services/cliente.service.js';
import CobradorZona from '../models/CobradorZona.js';
import * as XLSX from 'xlsx';

// ✅ NUEVO: recalcular vencidas antes de servir data al cobrador
import { actualizarCuotasVencidas, recalcularMoraPorCredito } from '../services/cuota.service.js';

// ✅ NUEVO: para obtener ids de créditos del cobrador y recalcular “al día” antes de responder
import Credito from '../models/Credito.js';

const router = Router();

/* ──────────────────────────────────────────────────────────
   MULTER: Subida de imagen de DNI (disco)
   ────────────────────────────────────────────────────────── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/dni';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

/* ──────────────────────────────────────────────────────────
   MULTER: Importación CSV/XLSX (memoria)
   ────────────────────────────────────────────────────────── */
const uploadImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExts = ['.csv', '.xls', '.xlsx'];
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      return cb(null, true);
    }
    cb(new Error('Formato no soportado. Subí un archivo CSV o XLSX.'));
  }
});

/* ──────────────────────────────────────────────────────────
   NUEVO: Plantilla base de importación
   ────────────────────────────────────────────────────────── */
/**
 * GET /clientes/import/template?format=xlsx|csv
 * - Por defecto: XLSX
 * - Roles: superadmin (0) y admin (1)
 */
router.get('/import/template', verifyToken, checkRole([0, 1]), async (req, res) => {
  try {
    const format = String(req.query.format || 'xlsx').toLowerCase();
    const headers = [
      'nombre',
      'apellido',
      'dni',
      'fecha_nacimiento',
      'fecha_registro',
      'email',
      'telefono',
      'telefono_secundario',
      'direccion',
      'direccion_secundaria',
      'referencia_direccion',
      'referencia_secundaria',
      'observaciones',
      'provincia',
      'localidad',
      'cobrador',          // ID de usuario (opcional)
      'cobrador_nombre',   // Alternativa por nombre (opcional)
      'zona',              // ID de zona (opcional)
      'zona_nombre',       // Alternativa por nombre (opcional)
      'historial_crediticio',
      'puntaje_crediticio'
    ];

    const example = {
      nombre: 'Juan',
      apellido: 'Pérez',
      dni: '30111222',
      fecha_nacimiento: '1990-05-10',
      fecha_registro: new Date().toISOString().slice(0, 10),
      email: 'juan.perez@example.com',
      telefono: '3815551234',
      telefono_secundario: '',
      direccion: 'Av. Siempreviva 742',
      direccion_secundaria: '',
      referencia_direccion: 'Puerta negra',
      referencia_secundaria: '',
      observaciones: 'Cliente nuevo',
      provincia: 'Tucumán',
      localidad: 'San Miguel de Tucumán',
      cobrador: '',
      cobrador_nombre: '',
      zona: '',
      zona_nombre: '',
      historial_crediticio: 'Desaprobado',
      puntaje_crediticio: 0
    };

    const rows = [example];

    if (format === 'csv') {
      const escape = (v) => {
        if (v == null) return '';
        const s = String(v);
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const csvHeader = headers.map(escape).join(',');
      const csvBody = rows
        .map((r) => headers.map((h) => escape(r[h] ?? '')).join(','))
        .join('\n');
      const csv = `${csvHeader}\n${csvBody}\n`;

      const filename = `plantilla_import_clientes_${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csv);
    }

    const wsData = [headers, ...rows.map(r => headers.map(h => r[h] ?? ''))];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Plantilla');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `plantilla_import_clientes_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error) {
    console.error('Error al generar plantilla de importación:', error);
    return res.status(500).json({ success: false, message: 'Error al generar la plantilla' });
  }
});

/* ──────────────────────────────────────────────────────────
   NUEVO: Definición de columnas/alias/tipos para validación front
   ────────────────────────────────────────────────────────── */
/**
 * GET /clientes/import/columns
 * - Devuelve columnas requeridas/opcionales, alias, tipos, ejemplos y notas
 * - Roles: superadmin (0) y admin (1)
 */
router.get('/import/columns', verifyToken, checkRole([0, 1]), (req, res) => {
  try {
    const payload = {
      required: ['nombre', 'apellido', 'dni'],
      optional: [
        'fecha_nacimiento', 'fecha_registro', 'email', 'telefono', 'telefono_secundario',
        'direccion', 'direccion_secundaria',
        'referencia_direccion', 'referencia_secundaria',
        'observaciones', 'provincia', 'localidad',
        'cobrador', 'cobrador_nombre',
        'zona', 'zona_nombre',
        'historial_crediticio', 'puntaje_crediticio'
      ],
      aliases: {
        telefono: ['telefono_1', 'teléfono'],
        telefono_secundario: ['telefono_2'],
        fecha_nacimiento: ['fecha nacimiento'],
        fecha_registro: ['fecha registro'],
        direccion: ['direccion_1', 'domicilio'],
        direccion_secundaria: ['direccion_2']
      },
      types: {
        nombre: 'string',
        apellido: 'string',
        dni: 'string-digits',
        fecha_nacimiento: 'date',
        fecha_registro: 'date',
        email: 'email',
        telefono: 'string',
        telefono_secundario: 'string',
        direccion: 'string',
        direccion_secundaria: 'string',
        referencia_direccion: 'string',
        referencia_secundaria: 'string',
        observaciones: 'string',
        provincia: 'string',
        localidad: 'string',
        cobrador: 'number|empty',
        cobrador_nombre: 'string|empty',
        zona: 'number|empty',
        zona_nombre: 'string|empty',
        historial_crediticio: 'string|empty',
        puntaje_crediticio: 'number|empty'
      },
      examples: {
        nombre: 'Juan',
        apellido: 'Pérez',
        dni: '30111222',
        fecha_nacimiento: '1990-05-10',
        fecha_registro: '2025-10-31',
        email: 'juan.perez@example.com',
        telefono: '3815551234',
        direccion: 'Av. Siempreviva 742',
        provincia: 'Tucumán',
        localidad: 'San Miguel de Tucumán',
        cobrador: '5',
        zona: '2'
      },
      notes: [
        'Upsert por "dni": si el DNI existe, se actualiza; si no, se crea.',
        '`cobrador`/`zona` aceptan ID numérico; `cobrador_nombre`/`zona_nombre` aceptan texto (case-insensitive).',
        'Fechas en formato ISO (YYYY-MM-DD).',
        'Los campos no incluidos se ignoran; `dni_foto` no forma parte de la importación por ahora.'
      ]
    };
    return res.json({ success: true, data: payload });
  } catch (error) {
    console.error('Error al exponer columnas de importación:', error);
    return res.status(500).json({ success: false, message: 'Error al obtener columnas' });
  }
});

/* ──────────────────────────────────────────────────────────
   ENDPOINTS
   ────────────────────────────────────────────────────────── */

// 🟣 Importar clientes por planilla (CSV/XLSX)
router.post(
  '/import',
  verifyToken,
  checkRole([0, 1]),
  uploadImport.single('file'),
  async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({
          success: false,
          message: 'No se recibió ningún archivo. Usá el campo "file".'
        });
      }

      // dryRun: por defecto true (preview). Para commit: ?dryRun=false
      const dryRun = String(req.query.dryRun ?? 'true').toLowerCase() !== 'false';

      const { summary, rows } = await importarClientesDesdePlanilla(
        req.file.buffer,
        req.file.originalname || 'import',
        { dryRun }
      );

      return res.json({
        success: true,
        message: dryRun
          ? 'Previsualización (dryRun) generada correctamente'
          : 'Importación realizada correctamente',
        summary,
        rows
      });
    } catch (error) {
      console.error('Error en importación de clientes:', error);
      return res.status(500).json({
        success: false,
        message: error?.message || 'Error al importar clientes'
      });
    }
  }
);

// Ruta: Subir foto del DNI y actualizar cliente
router.post('/:id/dni-foto', verifyToken, checkRole([0]), upload.single('imagen'), async (req, res) => {
  try {
    const { id } = req.params;
    const dni_foto = req.file?.filename;

    if (!dni_foto) {
      return res.status(400).json({ success: false, message: 'No se recibió ninguna imagen' });
    }

    await actualizarCliente(id, { dni_foto });

    res.json({
      success: true,
      message: 'Foto del DNI actualizada',
      url: `/uploads/dni/${dni_foto}`
    });
  } catch (error) {
    console.error('Error al subir foto del DNI:', error);
    res.status(500).json({ success: false, message: 'Error al subir la imagen' });
  }
});

// GET - Todos los clientes (listado completo)
router.get('/', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
  try {
    const clientes = await obtenerClientes(req.query);
    res.json({ success: true, data: clientes });
  } catch (error) {
    console.error('Error al obtener clientes:', error);
    res.status(500).json({ success: false, message: 'Error al obtener clientes' });
  }
});

// GET - Clientes básico (id, nombre, apellido, cobrador, zona) ideal para <select>
router.get('/basico', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
  try {
    const clientes = await obtenerClientesBasico(req.query);
    res.json({ success: true, data: clientes });
  } catch (error) {
    console.error('Error al obtener clientes (básico):', error);
    res.status(500).json({ success: false, message: 'Error al obtener clientes (básico)' });
  }
});

// GET - Clientes del cobrador (solo para rol 2 - Cobrador)
router.get('/por-cobrador/:id', verifyToken, checkRole([2]), async (req, res) => {
  try {
    // ✅ Seguridad opcional: si el middleware expone el id del usuario, validamos que coincida
    const tokenUserId = req.user?.id ?? req.userId ?? req.usuario?.id ?? null;
    if (tokenUserId != null && String(tokenUserId) !== String(req.params.id)) {
      return res.status(403).json({ success: false, message: 'No autorizado para consultar otra cartera' });
    }

    const cobradorId = Number(req.params.id);

    // ✅ 1) Marcamos vencidas “al día”
    await actualizarCuotasVencidas();

    // ✅ 2) Recalculamos mora/estado de TODA la cartera del cobrador ANTES de responder
    //     (así lo que se incluye en clientes→créditos→cuotas llega actualizado)
    const creditos = await Credito.findAll({
      where: { cobrador_id: cobradorId },
      attributes: ['id'],
      raw: true
    });

    for (const c of creditos) {
      // idempotente: si ya está ok, no rompe; si está viejo, lo actualiza
      await recalcularMoraPorCredito(c.id);
    }

    // ✅ 3) Ahora sí, traemos el árbol completo (clientes + créditos + cuotas) ya actualizado
    const clientes = await obtenerClientesPorCobrador(cobradorId);
    res.json({ success: true, data: clientes });
  } catch (error) {
    console.error('Error al obtener clientes por cobrador:', error);
    res.status(500).json({ success: false, message: 'Error al obtener clientes del cobrador' });
  }
});

// GET - Cliente por ID
router.get('/:id', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
  try {
    const cliente = await obtenerClientePorId(req.params.id);
    if (!cliente) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    res.json({ success: true, data: cliente });
  } catch (error) {
    console.error('Error al obtener cliente:', error);
    res.status(500).json({ success: false, message: 'Error interno' });
  }
});

// POST - Crear cliente
router.post('/', verifyToken, checkRole([0, 1]), async (req, res) => {
  try {
    const body = req.body;

    if (!body.nombre || !body.apellido || !body.dni || !body.direccion || !body.provincia ||
      !body.localidad || !body.telefono || !body.email || !body.fecha_nacimiento ||
      !body.fecha_registro || !body.cobrador || !body.zona) {
      return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
    }

    const zonasCobrador = await CobradorZona.findAll({
      where: { cobrador_id: body.cobrador },
      attributes: ['zona_id']
    });

    const zonaValida = zonasCobrador.some(z => z.zona_id.toString() === body.zona.toString());
    if (!zonaValida) {
      return res.status(400).json({ success: false, message: 'Zona no válida para este cobrador' });
    }

    const nuevoClienteId = await crearCliente(body);
    res.status(201).json({
      success: true,
      message: 'Cliente creado exitosamente',
      data: { id: nuevoClienteId }
    });
  } catch (error) {
    console.error('Error al crear cliente:', error);
    res.status(500).json({ success: false, message: 'Error interno' });
  }
});

// PUT - Actualizar cliente (solo superadmin)
router.put('/:id', verifyToken, checkRole([0]), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    if (!body.nombre || !body.apellido || !body.dni || !body.fecha_nacimiento || !body.fecha_registro ||
      !body.email || !body.telefono || !body.direccion || !body.provincia || !body.localidad ||
      !body.cobrador || !body.zona) {
      return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
    }

    const clienteActual = await obtenerClientePorId(id);
    if (!clienteActual) {
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    const bodyFinal = {
      ...body,
      dni_foto: body.dni_foto ?? clienteActual.dni_foto?.replace('http://localhost:3000/uploads/dni/', '') ?? null
    };

    await actualizarCliente(id, bodyFinal);
    res.json({ success: true, message: 'Cliente actualizado exitosamente' });
  } catch (error) {
    console.error('Error al actualizar cliente:', error);
    res.status(500).json({ success: false, message: 'Error interno' });
  }
});

// DELETE - Eliminar cliente (superadmin y admin)
router.delete('/:id', verifyToken, checkRole([0, 1]), async (req, res) => {
  try {
    await eliminarCliente(req.params.id);
    res.json({ success: true, message: 'Cliente eliminado exitosamente' });
  } catch (error) {
    console.error('Error al eliminar cliente:', error);
    res.status(500).json({ success: false, message: 'Error interno' });
  }
});

export default router;