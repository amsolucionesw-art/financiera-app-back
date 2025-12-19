// src/services/pago.service.js

import { registrarPagoParcial, pagarCuota, obtenerResumenLibrePorCredito } from './cuota.service.js';
import { Credito, Cuota } from '../models/associations.js';
import Pago from '../models/Pago.js';
import FormaPago from '../models/FormaPago.js';
import { differenceInCalendarMonths } from 'date-fns';

/*
  NOTA IMPORTANTE (Caja):
  -----------------------
  El impacto en CAJA (movimiento tipo "ingreso" por cada recibo generado)
  se realiza dentro de 'cuota.service.js' tanto para:
    - registrarPagoParcial(...)
    - pagarCuota(...)  (pago total)
  Este archivo no duplica ese asiento para evitar doble contabilización.

  ✅ DESCUENTOS (regla del negocio):
  - Admin (rol 1): SOLO puede aplicar descuentos sobre la MORA.
  - Superadmin (rol 0): idem, pero con permisos completos en el sistema.
  - Importante: el "blindaje real" está en cuota.service.js, donde el descuento
    se aplica únicamente contra la mora (NO toca capital).

  ⚠️ OJO:
  - cuota.service.js actualmente consume el campo "descuento".
  - Por eso, si queremos que el admin pueda descontar mora, debemos pasar
    el descuento por "descuento" (no por descuento_mora), pero garantizando
    que su uso sea mora-only (lo hace cuota.service.js).
*/

/* ───────────────── Constantes ───────────────── */
const LIBRE_MAX_CICLOS = 3;

/* ───────────────── Helpers numéricos ───────────────── */
const sanitizeNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return 0;
        // quita separadores de miles y convierte coma por punto
        const normalized = trimmed.replace(/\./g, '').replace(',', '.');
        const n = Number(normalized);
        return Number.isFinite(n) ? n : 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

const normalizePercent = (val, fallback = 60) => {
    const n = toNumber(val);
    if (!n) return fallback;
    if (n > 0 && n <= 1) return n * 100;
    return n;
};
const percentToDecimal = (pct) => toNumber(pct) / 100.0;

const toIntOrNull = (v) => {
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
};

/* ───────────────── Helpers de formateo UI ───────────────── */
const formatARS = (n) =>
    Number(n || 0).toLocaleString('es-AR', {
        style: 'currency',
        currency: 'ARS',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

const formatYMDToDMY = (ymd) => {
    if (!ymd) return '';
    // asume 'YYYY-MM-DD'
    const [Y, M, D] = String(ymd).split('-');
    if (!Y || !M || !D) return String(ymd);
    return `${D.padStart(2, '0')}/${M.padStart(2, '0')}/${Y}`;
};

const nonAplicaIfZero = (value) => {
    const n = toNumber(value);
    return n === 0 ? 'No aplica' : formatARS(n);
};

// Detección robusta de modalidad LIBRE a partir del payload del recibo
const esReciboLibre = (recibo = {}) => {
    const mod = String(recibo.modalidad_credito || '').toLowerCase();
    if (mod === 'libre') return true;
    const concepto = String(recibo.concepto || '');
    return /LIBRE/i.test(concepto);
};

/**
 * Mapea el modelo Recibo (numérico) a un objeto de presentación para UI.
 */
const buildReciboUI = (recibo) => {
    if (!recibo) return null;

    const libre = esReciboLibre(recibo);

    const {
        numero_recibo,
        fecha,
        hora,
        cliente_nombre,
        concepto,
        medio_pago,
        nombre_cobrador,
        modalidad_credito,

        // desglose
        importe_cuota_original,
        descuento_aplicado,
        mora_cobrada,
        principal_pagado,
        interes_ciclo_cobrado,

        // montos y saldos
        monto_pagado,
        pago_a_cuenta,
        saldo_anterior,
        saldo_actual,

        // Saldos de capital del crédito (solo LIBRE)
        saldo_credito_anterior,
        saldo_credito_actual
    } = recibo;

    const uiBase = {
        numero_recibo: numero_recibo ?? null,
        fecha: formatYMDToDMY(fecha),
        hora: hora || '',
        cliente: cliente_nombre || '',
        cobrador: nombre_cobrador || '',
        medio_pago: medio_pago || '',
        concepto: concepto || '',
        modalidad_credito: modalidad_credito || undefined,

        monto_pagado: formatARS(monto_pagado ?? pago_a_cuenta ?? 0),
        pago_a_cuenta: formatARS(pago_a_cuenta ?? monto_pagado ?? 0),

        saldo_anterior: formatARS(saldo_anterior),
        saldo_actual: formatARS(saldo_actual),

        importe_cuota_original:
            importe_cuota_original !== undefined ? formatARS(importe_cuota_original) : undefined,
        descuento_aplicado:
            descuento_aplicado !== undefined ? nonAplicaIfZero(descuento_aplicado) : undefined,
        mora_cobrada:
            mora_cobrada !== undefined ? nonAplicaIfZero(mora_cobrada) : undefined
    };

    if (!libre) {
        return { ...uiBase };
    }

    return {
        ...uiBase,
        principal_pagado: principal_pagado !== undefined ? formatARS(principal_pagado) : undefined,
        interes_ciclo_cobrado:
            interes_ciclo_cobrado !== undefined ? nonAplicaIfZero(interes_ciclo_cobrado) : undefined,
        saldo_credito_anterior:
            saldo_credito_anterior !== undefined ? formatARS(saldo_credito_anterior) : undefined,
        saldo_credito_actual:
            saldo_credito_actual !== undefined ? formatARS(saldo_credito_actual) : undefined
    };
};

/**
 * Determina el ciclo actual del crédito LIBRE
 */
const cicloLibreActual = (fechaAcreditacion) => {
    if (!fechaAcreditacion) return 1;
    const [Y, M, D] = String(fechaAcreditacion).split('-').map((x) => parseInt(x, 10));
    const inicio = new Date(Y, (M || 1) - 1, D || 1);
    const diffMeses = Math.max(differenceInCalendarMonths(new Date(), inicio), 0);
    return Math.min(LIBRE_MAX_CICLOS, diffMeses + 1);
};

const getModalidadCredito = (credito) => {
    const m =
        credito?.modalidad_credito ??
        credito?.modalidad ??
        credito?.tipo ??
        '';
    return String(m).toLowerCase();
};

/* ───────────────── Helpers permisos/discount ───────────────── */

/**
 * Devuelve el descuento "final" a enviar al cuota.service.js.
 * Regla:
 * - rol 1 (admin): descuento SOLO sobre mora.
 *   -> usamos descuento_mora si viene, sino descuento legacy.
 * - otros: usamos descuento legacy (y si viene descuento_mora, se puede priorizar si querés).
 *
 * IMPORTANTE:
 * - cuota.service.js ya aplica el descuento únicamente contra la mora.
 * - En LIBRE, cuota.service interpreta descuento como PORCENTAJE (0-100) sobre la mora.
 * - En NO-LIBRE, cuota.service interpreta descuento como MONTO sobre la mora.
 */
const resolveDescuentoParaCuotaService = ({ rolId, descuentoLegacy, descuentoMora }) => {
    const dl = sanitizeNumber(descuentoLegacy);
    const dm = sanitizeNumber(descuentoMora);

    if (dl < 0 || dm < 0) {
        const err = new Error('descuento no puede ser negativo.');
        err.status = 400;
        throw err;
    }

    if (rolId === 1) {
        // Admin: solo mora -> priorizo descuento_mora si existe, sino descuento legacy
        return dm > 0 ? dm : dl;
    }

    // Superadmin/otros: por compatibilidad, dejo legacy como principal
    // (si el front manda descuento_mora específicamente, también lo acepto)
    return dl > 0 ? dl : dm;
};

/* ───────────────── Registrar PAGO PARCIAL ───────────────── */
/**
 * Registrar PAGO PARCIAL de una cuota.
 * Body: { cuota_id, monto_pagado, forma_pago_id, observacion?, descuento?, descuento_mora?, modo? }
 *
 * REGLA:
 * - Admin (rol 1): puede aplicar descuento SOLO sobre mora (en cualquier modalidad).
 *   * En LIBRE: si no hay mora (no está vencido), el descuento simplemente no tendrá efecto.
 * - Superadmin: igual, pero sin limitaciones extra de UI.
 */
export const registrarPago = async (req, res) => {
    try {
        let {
            cuota_id,
            monto_pagado,
            forma_pago_id,
            observacion,
            descuento = 0,
            descuento_mora = null,
            modo
        } = req.body ?? {};

        // 🔐 usuario y rol desde token
        const usuarioId =
            req.user?.id ??
            req.user?.usuario_id ??
            req.user?.userId ??
            null;

        const rolIdRaw = req.user?.rol_id ?? req.user?.rol ?? null;
        const rolId = typeof rolIdRaw === 'number' ? rolIdRaw : toIntOrNull(rolIdRaw);

        // Defensa: si alguna ruta quedara abierta por error
        if (rolId === 2) {
            return res.status(403).json({
                success: false,
                error: 'Permiso denegado: un cobrador no puede registrar pagos desde este endpoint.'
            });
        }

        const cuotaIdInt = toIntOrNull(cuota_id);
        const formaPagoIdInt = toIntOrNull(forma_pago_id);

        if (!cuotaIdInt || !formaPagoIdInt || monto_pagado == null) {
            return res.status(400).json({
                success: false,
                error: 'Faltan datos: cuota_id, monto_pagado y forma_pago_id son obligatorios.'
            });
        }

        monto_pagado = sanitizeNumber(monto_pagado);
        if (!(monto_pagado > 0)) {
            return res.status(400).json({
                success: false,
                error: 'monto_pagado debe ser un número mayor a 0.'
            });
        }

        // Traigo cuota + crédito (para reglas de LIBRE)
        const cuota = await Cuota.findByPk(cuotaIdInt, {
            include: [{ model: Credito, as: 'credito' }]
        });
        if (!cuota || !cuota.credito) {
            return res.status(404).json({ success: false, error: 'Cuota o crédito no encontrados' });
        }

        const credito = cuota.credito;
        const modalidad = getModalidadCredito(credito);
        const esLibre = modalidad === 'libre';

        // Reglas de LIBRE (pago parcial permitido solo en ciclo 1-2)
        if (esLibre) {
            const ciclo = cicloLibreActual(credito.fecha_acreditacion || credito.fecha_compromiso_pago);
            if (ciclo >= 3) {
                return res.status(400).json({
                    success: false,
                    error: 'En el 3er mes del crédito LIBRE no se permite pago parcial. Debe registrar pago total (cancelación del crédito).'
                });
            }

            if (modo === 'solo_interes') {
                let interesPendienteHoy = null;

                try {
                    const resumen = await obtenerResumenLibrePorCredito(credito.id, new Date());
                    interesPendienteHoy = sanitizeNumber(resumen?.interes_pendiente_hoy);
                } catch (_) {
                    const tasaPct = normalizePercent(credito.interes, 60);
                    interesPendienteHoy = sanitizeNumber(credito.saldo_actual) * percentToDecimal(tasaPct);
                }

                if (Number.isFinite(interesPendienteHoy) && interesPendienteHoy > 0) {
                    monto_pagado = Math.min(monto_pagado, interesPendienteHoy);
                }
            }
        }

        // ✅ Descuento final (admin: solo mora)
        const descuentoFinal = resolveDescuentoParaCuotaService({
            rolId,
            descuentoLegacy: descuento,
            descuentoMora: descuento_mora
        });

        // registrarPagoParcial usa "descuento" (en cuota.service.js aplica solo a mora)
        const { cuota: cuotaRes, recibo } = await registrarPagoParcial({
            cuota_id: cuotaIdInt,
            monto_pagado,
            forma_pago_id: formaPagoIdInt,
            observacion,
            descuento: descuentoFinal,

            // contexto para caja/auditoría (aunque cuota.service hoy no lo use siempre)
            usuario_id: usuarioId ?? undefined,
            rol_id: rolId ?? undefined
        });

        const recibo_ui = buildReciboUI(recibo);

        return res.status(201).json({
            success: true,
            message: `Pago registrado. Estado actual de la cuota: ${cuotaRes?.estado ?? 'N/D'}`,
            cuota: cuotaRes,
            recibo,
            recibo_ui
        });
    } catch (error) {
        console.error('[registrarPago]', error);
        const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
        res.status(status).json({
            success: false,
            error: error?.message || 'Error al registrar el pago'
        });
    }
};

/* ───────────────── Registrar PAGO TOTAL ───────────────── */
/**
 * Registrar PAGO TOTAL de una cuota.
 *
 * REGLA:
 * - Admin (rol 1): puede aplicar descuento SOLO sobre mora (también en pago total).
 *   * En LIBRE: cuota.service interpreta descuento como % sobre mora.
 *   * En NO-LIBRE: cuota.service interpreta descuento como monto sobre mora.
 */
export const registrarPagoTotal = async (req, res) => {
    try {
        let {
            cuota_id,
            forma_pago_id,
            observacion,
            descuento = 0,
            descuento_mora = null
        } = req.body ?? {};

        const usuarioId =
            req.user?.id ??
            req.user?.usuario_id ??
            req.user?.userId ??
            null;

        const rolIdRaw = req.user?.rol_id ?? req.user?.rol ?? null;
        const rolId = typeof rolIdRaw === 'number' ? rolIdRaw : toIntOrNull(rolIdRaw);

        // Defensa: si alguna ruta quedara abierta por error
        if (rolId === 2) {
            return res.status(403).json({
                success: false,
                error: 'Permiso denegado: un cobrador no puede registrar pagos totales desde este endpoint.'
            });
        }

        const cuotaIdInt = toIntOrNull(cuota_id);
        const formaPagoIdInt = toIntOrNull(forma_pago_id);

        if (!cuotaIdInt || !formaPagoIdInt) {
            return res.status(400).json({
                success: false,
                error: 'Faltan datos: cuota_id y forma_pago_id son obligatorios.'
            });
        }

        // ✅ Descuento final (admin: solo mora)
        const descuentoFinal = resolveDescuentoParaCuotaService({
            rolId,
            descuentoLegacy: descuento,
            descuentoMora: descuento_mora
        });

        // pagarCuota decide internamente modalidad y cálculo
        const { cuota, recibo } = await pagarCuota({
            cuota_id: cuotaIdInt,
            forma_pago_id: formaPagoIdInt,
            descuento: descuentoFinal,
            observacion,

            // contexto para caja/auditoría (aunque cuota.service hoy no lo use siempre)
            usuario_id: usuarioId ?? undefined,
            rol_id: rolId ?? undefined
        });

        const recibo_ui = buildReciboUI(recibo);

        return res.status(201).json({
            success: true,
            message: `Pago total registrado. Estado actual de la cuota: ${cuota?.estado ?? 'N/D'}`,
            cuota,
            recibo,
            recibo_ui
        });
    } catch (error) {
        console.error('[registrarPagoTotal]', error);
        const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
        res.status(status).json({
            success: false,
            error: error?.message || 'Error al registrar el pago total'
        });
    }
};

/* ───────────────── Historial de pagos ───────────────── */
/**
 * Listar pagos de una cuota (historial).
 * Respuesta: { success: true, data: [ ...pagos ] }
 */
export const obtenerPagosPorCuota = async (req, res) => {
    try {
        const { cuotaId } = req.params ?? {};
        const cuotaIdInt = toIntOrNull(cuotaId);
        if (!cuotaIdInt) {
            return res.status(400).json({ success: false, message: 'Falta o es inválido el parámetro cuotaId' });
        }

        const pagos = await Pago.findAll({
            where: { cuota_id: cuotaIdInt },
            include: [{ model: FormaPago, as: 'formaPago', attributes: ['id', 'nombre'] }],
            order: [['fecha_pago', 'ASC'], ['id', 'ASC']]
        });

        res.json({ success: true, data: pagos });
    } catch (err) {
        console.error('[obtenerPagosPorCuota]', err);
        res.status(500).json({ success: false, message: 'Error al obtener historial de pagos', error: err?.message });
    }
};
