// backend/src/services/proveedor.service.js
import { Op } from 'sequelize';
import Proveedor from '../models/Proveedor.js';
import Gasto from '../models/Gasto.js';
import Compra from '../models/Compra.js';

/* ───────────────── Helpers ───────────────── */

const trimIfStr = (v) => (typeof v === 'string' ? v.trim() : v);
const sanitizeStr = (v, max = 255) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length ? s.slice(0, max) : null;
};

const sanitizeCUIT = (v) => {
    if (v === null || v === undefined) return null;
    // Mantiene dígitos y guiones (XX-XXXXXXXX-X). No validamos dígito verificador acá.
    const s = String(v).trim().replace(/[^\d-]/g, '');
    return s.length ? s.slice(0, 20) : null;
};

const sanitizeBool = (v, def = null) => {
    if (v === null || v === undefined || v === '') return def;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 't', 'yes', 'y', 'si', 'sí'].includes(s)) return true;
    if (['0', 'false', 'f', 'no', 'n'].includes(s)) return false;
    return def;
};

const sanitizeEmail = (v) => {
    const s = sanitizeStr(v, 200);
    if (!s) return null;
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    return ok ? s : null;
};

const buildQuery = (q = {}) => {
    const where = {};
    const { search, rubro, ciudad, provincia, cuil_cuit } = q;

    if (search && String(search).trim() !== '') {
        const s = String(search).trim();
        where[Op.or] = [
            { nombre_razon_social: { [Op.iLike]: `%${s}%` } },
            { cuil_cuit: { [Op.iLike]: `%${s}%` } },
            { rubro: { [Op.iLike]: `%${s}%` } },
            { ciudad: { [Op.iLike]: `%${s}%` } },
            { provincia: { [Op.iLike]: `%${s}%` } },
            { email: { [Op.iLike]: `%${s}%` } },
            { telefono: { [Op.iLike]: `%${s}%` } },
        ];
    }
    if (rubro) where.rubro = { [Op.iLike]: `%${String(rubro).trim()}%` };
    if (ciudad) where.ciudad = { [Op.iLike]: `%${String(ciudad).trim()}%` };
    if (provincia) where.provincia = { [Op.iLike]: `%${String(provincia).trim()}%` };
    if (cuil_cuit) where.cuil_cuit = { [Op.iLike]: `%${String(cuil_cuit).trim()}%` };

    return { where };
};

/* ───────────────── CRUD ───────────────── */

export const listarProveedores = async (req, res) => {
    try {
        const {
            limit = 100,
            offset = 0,
            orderBy = 'nombre_razon_social',
            orderDir = 'ASC',
            incluirTodos,       // si viene truthy, no forzamos activo=true por defecto
            activo,             // 'true' | 'false' | boolean
            ...filters
        } = req.query || {};

        const { where } = buildQuery(filters);

        // Filtro por ACTIVO:
        const activoParam = sanitizeBool(activo, null);
        const incluirTodosParam = sanitizeBool(incluirTodos, false);

        if (activoParam === true) {
            where.activo = true;
        } else if (activoParam === false) {
            where.activo = false;
        } else if (!incluirTodosParam) {
            // Por defecto, si no se pide explícito, solo activos
            where.activo = true;
        }
        // Si incluirTodos=true y no viene activo => no aplicamos filtro por activo.

        const rows = await Proveedor.findAll({
            where,
            order: [[orderBy, String(orderDir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC']],
            limit: Math.min(Number(limit) || 100, 500),
            offset: Math.max(Number(offset) || 0, 0),
        });

        // Si tu front espera {rows, count} podemos agregar count opcional
        const count = await Proveedor.count({ where });

        res.json({ success: true, data: rows, count });
    } catch (err) {
        console.error('[listarProveedores]', err);
        res.status(500).json({ success: false, message: 'Error al listar proveedores' });
    }
};

export const obtenerProveedor = async (req, res) => {
    try {
        const row = await Proveedor.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });
        res.json({ success: true, data: row });
    } catch (err) {
        console.error('[obtenerProveedor]', err);
        res.status(500).json({ success: false, message: 'Error al obtener proveedor' });
    }
};

export const crearProveedor = async (req, res) => {
    try {
        const body = req.body || {};

        const nombre_razon_social = sanitizeStr(body.nombre_razon_social, 200);
        const cuil_cuit = sanitizeCUIT(body.cuil_cuit);

        if (!nombre_razon_social || !cuil_cuit) {
            return res.status(400).json({ success: false, message: 'nombre_razon_social y cuil_cuit son obligatorios' });
        }

        // Alias direccion -> domicilio para compatibilidad con el front
        const domicilio = sanitizeStr(body.direccion ?? body.domicilio, 200);

        const payload = {
            nombre_razon_social,
            cuil_cuit,
            telefono: sanitizeStr(body.telefono, 50),
            domicilio,
            ciudad: sanitizeStr(body.ciudad, 100),
            provincia: sanitizeStr(body.provincia, 100),
            codigo_postal: sanitizeStr(body.codigo_postal, 20),
            rubro: sanitizeStr(body.rubro, 100),
            email: sanitizeEmail(body.email),
            notas: sanitizeStr(body.notas, 1000),
            // activo: default true si no viene
            activo: sanitizeBool(body.activo, true),
        };

        const exists = await Proveedor.findOne({ where: { cuil_cuit: payload.cuil_cuit } });
        if (exists) {
            return res.status(409).json({ success: false, message: 'Ya existe un proveedor con ese CUIT/CUIL' });
        }

        const row = await Proveedor.create(payload);
        res.status(201).json({ success: true, data: row });
    } catch (err) {
        console.error('[crearProveedor]', err);
        res.status(500).json({ success: false, message: 'Error al crear proveedor' });
    }
};

export const actualizarProveedor = async (req, res) => {
    try {
        const row = await Proveedor.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });

        const body = req.body || {};
        const data = {};

        if ('nombre_razon_social' in body) data.nombre_razon_social = sanitizeStr(body.nombre_razon_social, 200);
        if ('cuil_cuit' in body) data.cuil_cuit = sanitizeCUIT(body.cuil_cuit);
        if ('telefono' in body) data.telefono = sanitizeStr(body.telefono, 50);

        // Alias direccion/domicilio
        if ('direccion' in body || 'domicilio' in body) {
            data.domicilio = sanitizeStr(body.direccion ?? body.domicilio, 200);
        }

        if ('ciudad' in body) data.ciudad = sanitizeStr(body.ciudad, 100);
        if ('provincia' in body) data.provincia = sanitizeStr(body.provincia, 100);
        if ('codigo_postal' in body) data.codigo_postal = sanitizeStr(body.codigo_postal, 20);
        if ('rubro' in body) data.rubro = sanitizeStr(body.rubro, 100);
        if ('email' in body) data.email = sanitizeEmail(body.email);
        if ('notas' in body) data.notas = sanitizeStr(body.notas, 1000);
        if ('activo' in body) data.activo = sanitizeBool(body.activo, true);

        if (data.cuil_cuit && data.cuil_cuit !== row.cuil_cuit) {
            const exists = await Proveedor.findOne({ where: { cuil_cuit: data.cuil_cuit } });
            if (exists) {
                return res.status(409).json({ success: false, message: 'Ya existe un proveedor con ese CUIT/CUIL' });
            }
        }

        await row.update(data);
        res.json({ success: true, data: row });
    } catch (err) {
        console.error('[actualizarProveedor]', err);
        res.status(500).json({ success: false, message: 'Error al actualizar proveedor' });
    }
};

export const eliminarProveedor = async (req, res) => {
    try {
        const row = await Proveedor.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });

        // Evitamos borrar si tiene gastos o compras asociadas
        const [countGastos, countCompras] = await Promise.all([
            Gasto.count({ where: { proveedor_id: row.id } }),
            Compra.count({ where: { proveedor_id: row.id } }),
        ]);

        if (countGastos > 0 || countCompras > 0) {
            const partes = [];
            if (countGastos > 0) partes.push(`${countGastos} gasto(s)`);
            if (countCompras > 0) partes.push(`${countCompras} compra(s)`);
            return res.status(409).json({
                success: false,
                message: `No se puede eliminar: hay ${partes.join(' y ')} asociados a este proveedor.`
            });
        }

        await Proveedor.destroy({ where: { id: row.id } });
        res.json({ success: true, deleted: true });
    } catch (err) {
        console.error('[eliminarProveedor]', err);
        res.status(500).json({ success: false, message: 'Error al eliminar proveedor' });
    }
};
