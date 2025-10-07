// backend/src/routes/credito.routes.js

import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
    obtenerCreditos,
    obtenerCreditoPorId,
    crearCredito,
    actualizarCredito,
    eliminarCredito,
    obtenerCreditosPorCliente,
    cancelarCredito,
    esCreditoEliminable,
    obtenerResumenLibre,
    refinanciarCredito
} from '../services/credito.service.js';

const router = Router();

/* ───────────── Helpers ───────────── */
const TIPOS_VALIDOS = new Set(['semanal', 'quincenal', 'mensual']);
const MODS_VALIDAS = new Set(['comun', 'progresivo', 'libre']);
const ESTADOS_VALIDOS = new Set(['pendiente', 'parcial', 'vencido', 'pagado', 'refinanciado', 'anulado']);
const isValidYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isNum = (v) => v !== null && v !== undefined && !Number.isNaN(Number(v));
const isInt = (v) => Number.isInteger(Number(v));

/**
 * Valida el payload para crear/actualizar créditos.
 * Devuelve un array de strings con errores. Si está vacío, pasa validación.
 * - isUpdate=false: validaciones de requeridos mínimas para creación
 * - isUpdate=true: todos los campos son opcionales pero, si vienen, deben ser válidos
 */
function validarPayloadCredito(body = {}, isUpdate = false) {
    const errors = [];
    const {
        cliente_id,
        modalidad_credito,
        tipo_credito,
        interes,
        cantidad_cuotas,
        monto_acreditar,
        estado,
        descuento,
        fecha_solicitud,
        fecha_acreditacion,
        cobrador_id
    } = body ?? {};

    // cliente_id
    if (!isUpdate || cliente_id !== undefined) {
        if (!isNum(cliente_id) || Number(cliente_id) <= 0) {
            errors.push('cliente_id es requerido y debe ser numérico positivo');
        }
    }

    // modalidad_credito
    if (!isUpdate || modalidad_credito !== undefined) {
        const mod = String(modalidad_credito || '').toLowerCase();
        if (!MODS_VALIDAS.has(mod)) {
            errors.push('modalidad_credito inválida (comun|progresivo|libre)');
        }
    }

    // tipo_credito (requerido incluso para "libre" para calcular ciclos)
    if (!isUpdate || tipo_credito !== undefined) {
        const t = String(tipo_credito || '').toLowerCase();
        if (!TIPOS_VALIDOS.has(t)) {
            errors.push('tipo_credito inválido (semanal|quincenal|mensual)');
        }
    }

    // interes (acepta 0 o mayor; el service normaliza si viene 60 -> 0.60)
    if (!isUpdate || interes !== undefined) {
        if (!isNum(interes) || Number(interes) < 0) {
            errors.push('interes debe ser numérico y ≥ 0');
        }
    }

    // cantidad_cuotas (para no-libre: ≥1; para libre suele ser 1, pero no forzamos)
    if (!isUpdate || cantidad_cuotas !== undefined) {
        if (!isNum(cantidad_cuotas) || !isInt(cantidad_cuotas) || Number(cantidad_cuotas) < 1) {
            errors.push('cantidad_cuotas debe ser entero ≥ 1');
        }
    }

    // monto_acreditar (capital inicial)
    if (!isUpdate || monto_acreditar !== undefined) {
        if (!isNum(monto_acreditar) || Number(monto_acreditar) <= 0) {
            errors.push('monto_acreditar es requerido y debe ser numérico > 0');
        }
    }

    // estado (si viene)
    if (estado !== undefined) {
        const e = String(estado || '').toLowerCase();
        if (!ESTADOS_VALIDOS.has(e)) {
            errors.push('estado inválido');
        }
    }

    // descuento (si viene) 0..100
    if (descuento !== undefined) {
        if (!isNum(descuento) || Number(descuento) < 0 || Number(descuento) > 100) {
            errors.push('descuento debe estar entre 0 y 100 (porcentaje)');
        }
    }

    // fechas (opcionales). Permitimos fechas pasadas para tests de cuotas vencidas.
    if (fecha_solicitud !== undefined && fecha_solicitud !== null && fecha_solicitud !== '') {
        if (!isValidYMD(fecha_solicitud)) {
            errors.push('fecha_solicitud debe ser YYYY-MM-DD');
        }
    }
    if (fecha_acreditacion !== undefined && fecha_acreditacion !== null && fecha_acreditacion !== '') {
        if (!isValidYMD(fecha_acreditacion)) {
            errors.push('fecha_acreditacion debe ser YYYY-MM-DD');
        }
    }

    // cobrador_id (si viene)
    if (cobrador_id !== undefined && cobrador_id !== null && cobrador_id !== '') {
        if (!isNum(cobrador_id) || Number(cobrador_id) <= 0) {
            errors.push('cobrador_id debe ser numérico positivo si se envía');
        }
    }

    return errors;
}

/* 1) Créditos por cliente (con filtros opcionales)
   Query soportada:
   - estado: pendiente|parcial|vencido|pagado|refinanciado|anulado
   - modalidad: comun|progresivo|libre
   - tipo: semanal|quincenal|mensual
   - desde, hasta: YYYY-MM-DD
   - conCuotasVencidas: 1|true
*/
router.get(
    '/cliente/:clienteId',
    verifyToken, checkRole([0, 1, 2]),
    async (req, res) => {
        try {
            const clienteId = Number(req.params.clienteId);

            // Sanitizar/validar query sin romper compatibilidad
            const q = {};
            const { estado, modalidad, tipo, desde, hasta, conCuotasVencidas } = req.query || {};

            if (estado && ESTADOS_VALIDOS.has(String(estado).toLowerCase())) {
                q.estado = String(estado).toLowerCase();
            }
            if (modalidad && MODS_VALIDAS.has(String(modalidad).toLowerCase())) {
                q.modalidad = String(modalidad).toLowerCase();
            }
            if (tipo && TIPOS_VALIDOS.has(String(tipo).toLowerCase())) {
                q.tipo = String(tipo).toLowerCase();
            }
            if (desde) {
                if (!isValidYMD(desde)) {
                    return res.status(400).json({ success: false, message: 'El parámetro "desde" debe ser YYYY-MM-DD' });
                }
                q.desde = desde;
            }
            if (hasta) {
                if (!isValidYMD(hasta)) {
                    return res.status(400).json({ success: false, message: 'El parámetro "hasta" debe ser YYYY-MM-DD' });
                }
                q.hasta = hasta;
            }
            if (conCuotasVencidas !== undefined) {
                const val = String(conCuotasVencidas).toLowerCase();
                q.conCuotasVencidas = (val === '1' || val === 'true');
            }

            // Nuevo: pasamos query saneada al service (retrocompatible)
            const cliente = await obtenerCreditosPorCliente(clienteId, q);
            if (!cliente) {
                return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
            }
            res.json({ success: true, data: cliente });
        } catch (error) {
            console.error('Error al obtener créditos del cliente:', error);
            res.status(500).json({ success: false, message: 'Error al obtener créditos del cliente' });
        }
    }
);

/* 2) Obtener crédito por ID */
router.get(
    '/:id',
    verifyToken, checkRole([0, 1, 2]),
    async (req, res) => {
        try {
            const credito = await obtenerCreditoPorId(req.params.id);
            if (!credito) {
                return res.status(404).json({ success: false, message: 'Crédito no encontrado' });
            }
            res.json({ success: true, data: credito });
        } catch (error) {
            console.error('Error al obtener crédito:', error);
            res.status(500).json({ success: false, message: 'Error al obtener crédito' });
        }
    }
);

/* 2.1) Resumen LIBRE (capital, interés hoy, total) */
router.get(
    '/:id/resumen-libre',
    verifyToken, checkRole([0, 1, 2]),
    async (req, res) => {
        try {
            const { fecha } = req.query; // opcional: YYYY-MM-DD
            if (fecha && !isValidYMD(fecha)) {
                return res.status(400).json({ success: false, message: 'El parámetro "fecha" debe ser YYYY-MM-DD' });
            }
            const refDate = fecha ? new Date(fecha) : new Date();
            const data = await obtenerResumenLibre(Number(req.params.id), refDate);
            res.json({ success: true, data });
        } catch (error) {
            console.error('Error al obtener resumen libre:', error);
            res.status(500).json({ success: false, message: 'Error al obtener resumen libre' });
        }
    }
);

/* 2.2) Alias compat */
router.get(
    '/:id/libre/resumen',
    verifyToken, checkRole([0, 1, 2]),
    async (req, res) => {
        try {
            const { fecha } = req.query;
            if (fecha && !isValidYMD(fecha)) {
                return res.status(400).json({ success: false, message: 'El parámetro "fecha" debe ser YYYY-MM-DD' });
            }
            const refDate = fecha ? new Date(fecha) : new Date();
            const data = await obtenerResumenLibre(Number(req.params.id), refDate);
            res.json({ success: true, data });
        } catch (error) {
            console.error('Error al obtener resumen libre (alias):', error);
            res.status(500).json({ success: false, message: 'Error al obtener resumen libre' });
        }
    }
);

/* 3) Obtener todos los créditos */
router.get(
    '/',
    verifyToken, checkRole([0, 1, 2]),
    async (req, res) => {
        try {
            const lista = await obtenerCreditos(req.query);
            res.json({ success: true, data: lista });
        } catch (error) {
            console.error('Error al obtener créditos:', error);
            res.status(500).json({ success: false, message: 'Error al obtener créditos' });
        }
    }
);

/* 3.1) Pre-chequeo de eliminabilidad (solo superadmin) */
router.get(
    '/:id/eliminable',
    verifyToken, checkRole([0]),
    async (req, res) => {
        try {
            const { eliminable, cantidadPagos } = await esCreditoEliminable(req.params.id);
            res.json({ success: true, data: { eliminable, cantidadPagos } });
        } catch (error) {
            console.error('Error al verificar eliminabilidad del crédito:', error);
            res.status(500).json({ success: false, message: 'Error al verificar eliminabilidad del crédito' });
        }
    }
);

/* 4) Crear crédito */
router.post(
    '/',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const errors = validarPayloadCredito(req.body, false);
            if (errors.length) {
                return res.status(400).json({ success: false, message: 'Validación', errors });
            }
            const id = await crearCredito(req.body);
            const credito = await obtenerCreditoPorId(id);
            res.status(201).json({
                success: true,
                message: 'Crédito creado exitosamente',
                data: credito
            });
        } catch (error) {
            console.error('Error al crear crédito:', error);
            res.status(500).json({ success: false, message: 'Error al crear crédito' });
        }
    }
);

/* 4.1) Refinanciar crédito (P1/P2/Manual) */
router.post(
    '/:id/refinanciar',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const { opcion, tasaManual = 0, tipo_credito, cantidad_cuotas } = req.body || {};
            const valid = ['P1', 'P2', 'manual'];
            if (!valid.includes(opcion)) {
                return res.status(400).json({ success: false, message: 'Opción inválida (P1, P2 o manual)' });
            }
            if (tipo_credito && !TIPOS_VALIDOS.has(tipo_credito)) {
                return res.status(400).json({ success: false, message: 'tipo_credito inválido' });
            }
            const nuevoId = await refinanciarCredito({
                creditoId: Number(req.params.id),
                opcion,
                tasaManual,
                tipo_credito,
                cantidad_cuotas: cantidad_cuotas ? Number(cantidad_cuotas) : undefined
            });
            const creditoNuevo = await obtenerCreditoPorId(nuevoId);
            res.status(201).json({
                success: true,
                message: 'Crédito refinanciado exitosamente',
                data: creditoNuevo
            });
        } catch (error) {
            console.error('Error al refinanciar crédito:', error);
            res.status(500).json({ success: false, message: error?.message || 'Error al refinanciar crédito' });
        }
    }
);

/* 5) Actualizar crédito */
router.put(
    '/:id',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const errors = validarPayloadCredito(req.body, true);
            if (errors.length) {
                return res.status(400).json({ success: false, message: 'Validación', errors });
            }
            await actualizarCredito(req.params.id, req.body);
            const credito = await obtenerCreditoPorId(req.params.id);
            res.json({
                success: true,
                message: 'Crédito actualizado exitosamente',
                data: credito
            });
        } catch (error) {
            console.error('Error al actualizar crédito:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar crédito' });
        }
    }
);

/* 6) Eliminar crédito */
router.delete(
    '/:id',
    verifyToken, checkRole([0]),
    async (req, res) => {
        try {
            // Pre-chequeo para evitar error de FK y dar mensaje claro
            const { eliminable, cantidadPagos } = await esCreditoEliminable(req.params.id);
            if (!eliminable) {
                return res.status(409).json({
                    success: false,
                    message: `No se puede eliminar el crédito porque tiene pagos registrados (${cantidadPagos}).`
                });
            }

            const resp = await eliminarCredito(req.params.id);
            res.json({ success: true, message: resp?.mensaje || 'Crédito eliminado exitosamente' });
        } catch (error) {
            console.error('Error al eliminar crédito:', error);
            const status = error?.status || 500;
            res.status(status).json({
                success: false,
                message: error?.message || 'Error al eliminar crédito'
            });
        }
    }
);

/* 7) Cancelar crédito (UN recibo) */
router.post(
    '/:id/cancelar',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const { forma_pago_id, descuento_porcentaje = 0, observacion = null } = req.body || {};
            const data = await cancelarCredito({
                credito_id: Number(req.params.id),
                forma_pago_id,
                descuento_porcentaje,
                observacion
            });
            res.json({ success: true, message: 'Crédito cancelado', data });
        } catch (error) {
            console.error('Error al cancelar crédito:', error);
            const status = error?.status || 500;
            res.status(status).json({ success: false, message: error?.message || 'Error al cancelar crédito' });
        }
    }
);

export default router;
