// src/routes/cuotas.routes.js
import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
    obtenerCuotas,
    obtenerCuotaPorId,
    actualizarCuota,
    pagarCuota,
    actualizarCuotasVencidas,
    obtenerCuotasPorCredito,
    registrarPagoParcial,
    // Asegurate de tener estos exportados en services/cuota.service.js
    recalcularMoraCuota,
    recalcularMoraPorCredito,
    crearCuota,
    eliminarCuota,
    // NUEVO: endpoint para tabla de cuotas vencidas
    obtenerCuotasVencidas
} from '../services/cuota.service.js';

const router = Router();

/* ──────────────────────────────────────────────────────────────────────────
 * Crear nueva cuota (Superadmin y Admin)
 * ────────────────────────────────────────────────────────────────────────── */
router.post('/', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const cuota = await crearCuota(req.body);
        res.status(201).json({
            success: true,
            message: 'Cuota creada exitosamente',
            data: cuota
        });
    } catch (error) {
        console.error('Error al crear cuota:', error);
        res.status(500).json({ success: false, message: 'Error al crear cuota' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Ver todas las cuotas (Superadmin, Admin y Cobrador)
 * ────────────────────────────────────────────────────────────────────────── */
router.get('/', verifyToken, checkRole([0, 1, 2]), async (_req, res) => {
    try {
        const cuotas = await obtenerCuotas();
        res.json({ success: true, data: cuotas });
    } catch (error) {
        console.error('Error al obtener cuotas:', error);
        res.status(500).json({ success: false, message: 'Error al obtener cuotas' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * NUEVO: Listar solo cuotas vencidas (para la notificación)
 * - Soporta filtros por querystring:
 *   ?clienteId=&cobradorId=&zonaId=&desde=YYYY-MM-DD&hasta=YYYY-MM-DD&minDiasVencida=#
 * - Respuesta preparada para tabla (cliente, monto, linkable por cuota_id)
 * ────────────────────────────────────────────────────────────────────────── */
router.get('/vencidas', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
    try {
        const lista = await obtenerCuotasVencidas(req.query);
        res.json({ success: true, data: lista });
    } catch (error) {
        console.error('Error al obtener cuotas vencidas:', error);
        res.status(500).json({ success: false, message: 'Error al obtener cuotas vencidas' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Ver cuota por ID
 * ────────────────────────────────────────────────────────────────────────── */
router.get('/:id', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
    try {
        const cuota = await obtenerCuotaPorId(req.params.id);
        if (!cuota) {
            return res.status(404).json({ success: false, message: 'Cuota no encontrada' });
        }
        res.json({ success: true, data: cuota });
    } catch (error) {
        console.error('Error al obtener cuota por ID:', error);
        res.status(500).json({ success: false, message: 'Error al obtener cuota' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Actualizar cuota (Superadmin y Admin)
 * ────────────────────────────────────────────────────────────────────────── */
router.put('/:id', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const cuotaActualizada = await actualizarCuota(req.params.id, req.body);
        if (!cuotaActualizada) {
            return res.status(404).json({ success: false, message: 'Cuota no encontrada' });
        }
        res.json({
            success: true,
            message: 'Cuota actualizada exitosamente',
            data: cuotaActualizada
        });
    } catch (error) {
        console.error('Error al actualizar cuota:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar cuota' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Eliminar cuota (Superadmin y Admin)
 * ────────────────────────────────────────────────────────────────────────── */
router.delete('/:id', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const eliminado = await eliminarCuota(req.params.id);
        if (!eliminado) {
            return res.status(404).json({ success: false, message: 'Cuota no encontrada' });
        }
        res.json({ success: true, message: 'Cuota eliminada exitosamente' });
    } catch (error) {
        console.error('Error al eliminar cuota:', error);
        res.status(500).json({ success: false, message: 'Error al eliminar cuota' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Pagar cuota (acepta descuento opcional)
 * - Créditos comunes/progresivos: el service cobra primero MORA del día y luego principal.
 * - Crédito "libre": el service hace LIQUIDACIÓN TOTAL (interés del/los ciclo/s SIN mora + capital),
 *   pudiendo aplicar descuento opcional (%) sobre el total si lo enviás en el body como "descuento".
 * RESPUESTA: { cuota, recibo } + campos legacy para compatibilidad
 *
 * ⚠️ Impactar pago: solo Admin (1) y Superadmin (0).
 * ⚠️ Descuento: se validará en el service para que solo rol 0 pueda aplicarlo.
 * ────────────────────────────────────────────────────────────────────────── */
router.put('/pagar/:id', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const { forma_pago_id, descuento = 0, observacion = null } = req.body || {};
        if (!forma_pago_id) {
            return res.status(400).json({
                success: false,
                message: 'Debe proporcionar la forma de pago'
            });
        }

        const result = await pagarCuota({
            cuota_id: req.params.id,
            forma_pago_id,
            descuento,
            observacion,
            rol_id: req.user.rol_id,      // para reglas de descuento en el service
            usuario_id: req.user.id       // 🆕 para registrar el usuario en CajaMovimiento
        });

        // Nuevo service retorna { cuota, recibo }
        const cuota = result?.cuota ?? result; // fallback por si algún entorno viejo devuelve solo cuota
        const recibo = result?.recibo ?? null;

        if (!cuota) {
            return res.status(404).json({ success: false, message: 'Cuota no encontrada' });
        }

        res.json({
            success: true,
            message: 'Cuota pagada correctamente',
            data: {
                // Nuevo contrato
                cuota,
                recibo,
                // Campos legacy (por si hay pantallas que los lean directamente)
                id: cuota.id,
                estado: cuota.estado,
                forma_pago_id: cuota.forma_pago_id,
                intereses_vencidos_acumulados: cuota.intereses_vencidos_acumulados ?? 0,
                monto_pagado_acumulado: cuota.monto_pagado_acumulado,
                descuento_cuota: cuota.descuento_cuota
            }
        });
    } catch (error) {
        console.error('Error al pagar cuota:', error);
        res.status(500).json({ success: false, message: 'Error al pagar cuota' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Actualizar cuotas vencidas automáticamente
 * (El service excluye créditos "libre" y fecha ficticia 2099-12-31)
 * ────────────────────────────────────────────────────────────────────────── */
router.put('/actualizar-vencidas', verifyToken, checkRole([0, 1, 2]), async (_req, res) => {
    try {
        const resultado = await actualizarCuotasVencidas();
        res.json({ success: true, message: 'Cuotas vencidas actualizadas', data: resultado });
    } catch (error) {
        console.error('Error al actualizar cuotas vencidas:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar cuotas vencidas' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Recalcular mora de UNA cuota (idempotente)
 * (Para "libre" siempre queda en 0)
 * ────────────────────────────────────────────────────────────────────────── */
router.put('/:id/recalcular-mora', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const mora = await recalcularMoraCuota(req.params.id);
        res.json({
            success: true,
            message: 'Mora recalculada para la cuota',
            data: { cuota_id: req.params.id, mora }
        });
    } catch (error) {
        console.error('Error al recalcular mora de la cuota:', error);
        res.status(500).json({ success: false, message: 'Error al recalcular mora de la cuota' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Recalcular mora por lote (idempotente)
 * Body admite:
 *   - { credito_id }
 *   - { cuota_ids: [..] }
 *   - { todas_vencidas: true }
 * (En "libre" la mora es 0)
 * ────────────────────────────────────────────────────────────────────────── */
router.post('/recalcular-mora', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const { credito_id, cuota_ids, todas_vencidas } = req.body ?? {};

        if (credito_id) {
            const total = await recalcularMoraPorCredito(credito_id);
            return res.json({
                success: true,
                scope: 'credito',
                credito_id,
                total_mora_recalculada: total
            });
        }

        if (Array.isArray(cuota_ids) && cuota_ids.length > 0) {
            const resultados = [];
            for (const id of cuota_ids) {
                const mora = await recalcularMoraCuota(id);
                resultados.push({ cuota_id: id, mora });
            }
            return res.json({
                success: true,
                scope: 'cuotas',
                resultados
            });
        }

        if (todas_vencidas) {
            // obtengo todas las vencidas y recalculo
            const { default: Cuota } = await import('../models/Cuota.js');
            const vencidas = await Cuota.findAll({ where: { estado: 'vencida' }, attributes: ['id'] });
            const resultados = [];
            for (const c of vencidas) {
                const mora = await recalcularMoraCuota(c.id);
                resultados.push({ cuota_id: c.id, mora });
            }
            return res.json({
                success: true,
                scope: 'todas_vencidas',
                resultados
            });
        }

        return res.status(400).json({
            success: false,
            message: 'Debe indicar credito_id, cuota_ids o todas_vencidas'
        });
    } catch (error) {
        console.error('Error al recalcular mora:', error);
        res.status(500).json({ success: false, message: 'Error al recalcular mora' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Obtener cuotas por crédito (recalcula mora en el service)
 * ────────────────────────────────────────────────────────────────────────── */
router.get('/credito/:creditoId', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
    try {
        const cuotas = await obtenerCuotasPorCredito(req.params.creditoId);
        res.json({ success: true, data: cuotas });
    } catch (error) {
        console.error('Error al obtener cuotas por crédito:', error);
        res.status(500).json({ success: false, message: 'Error al obtener cuotas por crédito' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Registrar pago parcial (acepta descuento opcional en body)
 * - En "libre": primero interés del/los ciclo/s transcurridos, luego capital.
 * - En común/progresivo: primero mora, luego principal.
 *
 * ⚠️ Impactar pago: solo Admin (1) y Superadmin (0).
 * ⚠️ Descuento: se validará en el service para que solo rol 0 pueda aplicarlo.
 * ────────────────────────────────────────────────────────────────────────── */
router.post('/pago-parcial', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const data = await registrarPagoParcial({
            ...req.body,
            rol_id: req.user.rol_id,   // reglas de descuento en el service
            usuario_id: req.user.id    // 🆕 registrar usuario en CajaMovimiento
        });
        res.status(200).json({
            success: true,
            message: 'Pago parcial registrado exitosamente',
            data
        });
    } catch (error) {
        console.error('Error al registrar pago parcial:', error);
        res.status(500).json({ success: false, message: 'Error al registrar pago parcial' });
    }
});

export default router;