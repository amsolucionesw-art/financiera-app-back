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
  obtenerClientesPorCobrador
} from '../services/cliente.service.js';
import CobradorZona from '../models/CobradorZona.js';

const router = Router();

// Configuración de multer para imagen del DNI
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
   ENDPOINTS
   ────────────────────────────────────────────────────────── */

// Ruta: Subir foto del DNI y actualizar cliente
router.post('/:id/dni-foto', verifyToken, checkRole([0, 1]), upload.single('imagen'), async (req, res) => {
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
// Soporta filtros por query: ?cobrador=ID, ?zona=ID, etc.
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
    const clientes = await obtenerClientesPorCobrador(req.params.id);
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

// PUT - Actualizar cliente
router.put('/:id', verifyToken, checkRole([0, 1]), async (req, res) => {
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

// DELETE - Eliminar cliente
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