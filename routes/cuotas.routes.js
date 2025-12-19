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
 * Helpers TZ (coherencia)
 * ────────────────────────────────────────────────────────────────────────── */
const APP_TZ = process.env.APP_TZ || 'America/Argentina/Tucuman';
const todayYMD = () =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: APP_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers descuento / modalidad
 * ────────────────────────────────────────────────────────────────────────── */
const toNumber = (v) => {
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

const normalizePct = (v) => {
    const n = toNumber(v);
    if (n <= 0) return 0;
    // descuento en %: clamp 0..100 por seguridad
    if (n > 100) return 100;
    return n;
};

const getModalidadFromCuota = (cuota) => {
    // Intentamos cubrir distintas formas de retorno del service
    const m =
        cuota?.Credito?.modalidad ??
        cuota?.Credito?.modalidad_credito ??
        cuota?.credito?.modalidad ??
        cuota?.credito?.modalidad_credito ??
        cuota?.credito?.tipo ??
        null;

    return m ? String(m).toLowerCase() : null;
};

const resolveModalidadByCreditoId = async (creditoId) => {
    if (!creditoId) return null;
    try {
        const { default: Credito } = await import('../models/Credito.js');
        const c = await Credito.findByPk(creditoId, { attributes: ['id', 'modalidad'] });
        const m = c?.modalidad ? String(c.modalidad).toLowerCase() : null;
        return m;
    } catch {
        // si el modelo no está en esa ruta o falla, devolvemos null
        return null;
    }
};

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
 * NUEVO: Ruta de cobro del cobrador logueado
 * ────────────────────────────────────────────────────────────────────────── */
router.get('/ruta-cobro', verifyToken, checkRole([0, 1, 2]), async (req, res) => {
    try {
        const rol_id = req.user?.rol_id ?? null;

        // Si es cobrador (rol 2) SIEMPRE usa su propio usuario_id
        const cobrador_id =
            rol_id === 2
                ? req.user?.id
                : (req.query?.cobradorId ? Number(req.query.cobradorId) : null);

        if (!cobrador_id || !Number.isFinite(Number(cobrador_id))) {
            return res.status(400).json({
                success: false,
                message:
                    rol_id === 2
                        ? 'No se pudo identificar el cobrador del token'
                        : 'Debe indicar cobradorId en query (solo admin/superadmin)'
            });
        }

        const includeVencidas = String(req.query?.includeVencidas ?? '1') !== '0';
        const includePendientesHoy = String(req.query?.includePendientesHoy ?? '1') !== '0';
        const hoy = todayYMD();

        const cuotaService = await import('../services/cuota.service.js');
        const fn =
            cuotaService.obtenerRutaCobroCobrador ||
            cuotaService.obtenerRutaCobro ||
            null;

        if (typeof fn !== 'function') {
            return res.status(501).json({
                success: false,
                message:
                    'La ruta de cobro aún no está implementada en el service (falta export).',
                hint:
                    'Agregá y exportá `obtenerRutaCobroCobrador` en `src/services/cuota.service.js` para usar /cuotas/ruta-cobro'
            });
        }

        const result = await fn({
            // seguridad / contexto
            rol_id,
            usuario_id: req.user?.id,
            cobrador_id,

            // negocio
            hoy,
            includeVencidas,
            includePendientesHoy,

            // filtros opcionales (si los querés soportar en el service)
            zonaId: req.query?.zonaId,
            clienteId: req.query?.clienteId,

            // modo de respuesta
            modo: req.query?.modo // 'plano' | 'separado' (si lo implementan)
        });

        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Error al obtener ruta de cobro:', error);
        res.status(500).json({ success: false, message: 'Error al obtener ruta de cobro' });
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
 *
 * REGLA NUEVA:
 * - Superadmin (0): puede aplicar descuento normal (según reglas del service)
 * - Admin (1): SOLO puede aplicar descuento SOBRE MORA
 *   - En créditos "libre" NO hay mora => si admin manda descuento, se rechaza (403)
 *
 * Nota: enviamos `descuento_scope: 'mora'` para que el service aplique el descuento
 * únicamente a mora (blindaje definitivo en el próximo paso).
 * ────────────────────────────────────────────────────────────────────────── */
router.put('/pagar/:id', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const rol_id = req.user?.rol_id ?? null;
        const usuario_id = req.user?.id ?? null;

        const { forma_pago_id, descuento_mora = null, descuento = 0, observacion = null } = req.body || {};
        if (!forma_pago_id) {
            return res.status(400).json({
                success: false,
                message: 'Debe proporcionar la forma de pago'
            });
        }

        // Admin: si manda descuento, es descuento solo mora
        let descuentoToSend = normalizePct(descuento);
        if (rol_id === 1) {
            descuentoToSend = normalizePct(descuento_mora !== null ? descuento_mora : descuento);

            if (descuentoToSend > 0) {
                // Bloqueo fuerte: admin no puede "descontar" en Libre (sería capital/interés)
                const cuotaInfo = await obtenerCuotaPorId(req.params.id);
                if (!cuotaInfo) {
                    return res.status(404).json({ success: false, message: 'Cuota no encontrada' });
                }
                const modalidad = getModalidadFromCuota(cuotaInfo);
                if (modalidad === 'libre') {
                    return res.status(403).json({
                        success: false,
                        message: 'Permiso denegado: el admin solo puede aplicar descuentos sobre la mora. En créditos LIBRE no hay mora para descontar.'
                    });
                }
            }
        }

        const result = await pagarCuota({
            cuota_id: req.params.id,
            forma_pago_id,
            descuento: descuentoToSend,
            observacion,
            rol_id,
            usuario_id,

            // bandera para que el service aplique el descuento SOLO a mora (admin)
            descuento_scope: rol_id === 1 ? 'mora' : 'total'
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
 *
 * REGLA NUEVA:
 * - Superadmin (0): descuento normal
 * - Admin (1): SOLO descuento sobre mora
 *   - Si podemos determinar que es crédito LIBRE y admin manda descuento => 403
 *
 * Enviamos `descuento_scope` para que el service aplique el descuento únicamente a mora.
 * ────────────────────────────────────────────────────────────────────────── */
router.post('/pago-parcial', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const rol_id = req.user?.rol_id ?? null;
        const usuario_id = req.user?.id ?? null;

        // Permitimos nuevo campo descuento_mora, manteniendo compatibilidad con descuento
        const descuentoIncoming = (req.body?.descuento_mora !== undefined && req.body?.descuento_mora !== null)
            ? req.body.descuento_mora
            : req.body?.descuento;

        const descuentoToSend = normalizePct(descuentoIncoming);

        if (rol_id === 1 && descuentoToSend > 0) {
            // Best-effort: intentar detectar libre para bloquear
            const cuotaId = req.body?.cuota_id ?? req.body?.cuotaId ?? null;
            const creditoId = req.body?.credito_id ?? req.body?.creditoId ?? null;

            let modalidad = null;

            if (cuotaId) {
                const cuotaInfo = await obtenerCuotaPorId(cuotaId);
                modalidad = cuotaInfo ? getModalidadFromCuota(cuotaInfo) : null;
            } else if (creditoId) {
                modalidad = await resolveModalidadByCreditoId(creditoId);
            }

            if (modalidad === 'libre') {
                return res.status(403).json({
                    success: false,
                    message: 'Permiso denegado: el admin solo puede aplicar descuentos sobre la mora. En créditos LIBRE no hay mora para descontar.'
                });
            }
        }

        const data = await registrarPagoParcial({
            ...req.body,
            // sobreescribimos descuento con el normalizado (por compatibilidad)
            descuento: descuentoToSend,
            rol_id,
            usuario_id,
            descuento_scope: rol_id === 1 ? 'mora' : 'total'
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