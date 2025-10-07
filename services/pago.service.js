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

/**
 * Mapea el modelo Recibo (numérico) a un objeto de presentación para UI.
 * Reglas:
 *  - descuento_aplicado, mora_cobrada, interes_ciclo_cobrado → "No aplica" si 0
 *  - saldos y montos siempre con formato dinero
 *  - excepción: saldo_actual = 0 se muestra "$0,00" (no "No aplica")
 */
const buildReciboUI = (recibo) => {
    if (!recibo) return null;

    // Campos numéricos (según armarDatosRecibo en cuota.service.js)
    const {
        numero_recibo,
        fecha,
        hora,
        cliente_nombre,
        concepto,
        medio_pago,

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
        saldo_credito_anterior,
        saldo_credito_actual,

        // opcionales de identificación
        nombre_cobrador
    } = recibo;

    // Importante: saldos siempre en $ (incluido $0,00)
    const saldoActualFmt = formatARS(saldo_actual);
    const saldoCreditoActualFmt = formatARS(saldo_credito_actual);

    return {
        numero_recibo: numero_recibo ?? null,
        fecha: formatYMDToDMY(fecha),
        hora: hora || '',
        cliente: cliente_nombre || '',
        cobrador: nombre_cobrador || '',
        medio_pago: medio_pago || '',
        concepto: concepto || '',

        // Totales/montos
        monto_pagado: formatARS(monto_pagado ?? pago_a_cuenta ?? 0),
        pago_a_cuenta: formatARS(pago_a_cuenta ?? monto_pagado ?? 0),

        // Saldos (monetarios siempre)
        saldo_anterior: formatARS(saldo_anterior),
        saldo_actual: saldoActualFmt, // ← excepción: mostrar $0,00 si corresponde
        saldo_credito_anterior: formatARS(saldo_credito_anterior),
        saldo_credito_actual: saldoCreditoActualFmt,

        // Desglose con "No aplica" como corresponde
        importe_cuota_original: formatARS(importe_cuota_original),
        descuento_aplicado: nonAplicaIfZero(descuento_aplicado),
        mora_cobrada: nonAplicaIfZero(mora_cobrada),
        principal_pagado: formatARS(principal_pagado),
        interes_ciclo_cobrado: nonAplicaIfZero(interes_ciclo_cobrado)
    };
};

/**
 * Determina el ciclo actual del crédito LIBRE:
 *  - ciclo 1: mes 0 desde fecha_acreditacion
 *  - ciclo 2: mes 1
 *  - ciclo 3: mes 2
 */
const cicloLibreActual = (fechaAcreditacion) => {
    if (!fechaAcreditacion) return 1;
    const [Y, M, D] = String(fechaAcreditacion).split('-').map((x) => parseInt(x, 10));
    const inicio = new Date(Y, (M || 1) - 1, D || 1);
    const diffMeses = Math.max(differenceInCalendarMonths(new Date(), inicio), 0);
    return Math.min(LIBRE_MAX_CICLOS, diffMeses + 1);
};

/* ───────────────── Registrar PAGO PARCIAL ───────────────── */
/**
 * Registrar PAGO PARCIAL de una cuota.
 * Body: { cuota_id, monto_pagado, forma_pago_id, observacion?, descuento?, modo? }
 *  - modo (sólo LIBRE):
 *      - "solo_interes": mes 1 o 2 permite pagar sólo INTERÉS del ciclo (mes 3 → RECHAZA).
 *      - "interes_y_capital" (o ausente): primero interés del ciclo, sobrante a capital.
 *
 *  - común/progresivo: sin cambios (primero mora, luego principal; descuento = MONTO sobre principal).
 *
 * Respuesta: { success, message, cuota, recibo, recibo_ui }
 */
export const registrarPago = async (req, res) => {
    try {
        let { cuota_id, monto_pagado, forma_pago_id, observacion, descuento = 0, modo } = req.body ?? {};

        // Validaciones mínimas
        const cuotaIdInt = toIntOrNull(cuota_id);
        const formaPagoIdInt = toIntOrNull(forma_pago_id);
        if (!cuotaIdInt || !formaPagoIdInt || monto_pagado == null) {
            return res.status(400).json({
                success: false,
                error: 'Faltan datos: cuota_id, monto_pagado y forma_pago_id son obligatorios.'
            });
        }

        // Sanitizo numéricos (admite "1.234,56")
        monto_pagado = sanitizeNumber(monto_pagado);
        descuento = sanitizeNumber(descuento);

        if (!(monto_pagado > 0)) {
            return res.status(400).json({
                success: false,
                error: 'monto_pagado debe ser un número mayor a 0.'
            });
        }
        if (descuento < 0) {
            return res.status(400).json({
                success: false,
                error: 'descuento no puede ser negativo.'
            });
        }

        // Traigo cuota + crédito (para detectar modalidad y ciclo en LIBRE)
        const cuota = await Cuota.findByPk(cuotaIdInt, {
            include: [{ model: Credito, as: 'credito' }]
        });
        if (!cuota || !cuota.credito) {
            return res.status(404).json({ success: false, error: 'Cuota o crédito no encontrados' });
        }

        const credito = cuota.credito;
        const esLibre = String(credito.modalidad_credito) === 'libre';

        if (esLibre) {
            const ciclo = cicloLibreActual(credito.fecha_acreditacion || credito.fecha_compromiso_pago);
            // En mes 3 NO se admite pago parcial → debe usarse pago total (cancelación)
            if (ciclo >= 3) {
                return res.status(400).json({
                    success: false,
                    error: 'En el 3er mes del crédito LIBRE no se permite pago parcial. Debe registrar pago total (cancelación del crédito).'
                });
            }

            // Si el usuario pide "solo_interes": recorto el pago al interés pendiente del ciclo
            if (modo === 'solo_interes') {
                let interesPendienteHoy = null;

                // Intento obtener el resumen de libre desde cuota.service (si no existe, fallback)
                try {
                    const resumen = await obtenerResumenLibrePorCredito(credito.id, new Date());
                    // Se espera algo como { interes_pendiente_hoy, ... }
                    interesPendienteHoy = sanitizeNumber(resumen?.interes_pendiente_hoy);
                } catch (_) {
                    // Fallback: interés aprox = saldo_actual * tasa_mes
                    const tasaPct = normalizePercent(credito.interes, 60);
                    interesPendienteHoy = sanitizeNumber(credito.saldo_actual) * percentToDecimal(tasaPct);
                }

                if (Number.isFinite(interesPendienteHoy) && interesPendienteHoy > 0) {
                    // Pago solo por interés del ciclo (capo el monto al interés)
                    monto_pagado = Math.min(monto_pagado, interesPendienteHoy);
                }
                // Si no se pudo calcular, dejamos que cuota.service asigne el reparto.
            }
            // modo "interes_y_capital" (o ausente) → sin cambios: cuota.service prioriza interés del ciclo y luego capital.
        }

        // Ahora retorna { cuota, recibo }
        const { cuota: cuotaRes, recibo } = await registrarPagoParcial({
            cuota_id: cuotaIdInt,
            monto_pagado,
            forma_pago_id: formaPagoIdInt,
            observacion,
            descuento
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
        res.status(500).json({
            success: false,
            error: error?.message || 'Error al registrar el pago'
        });
    }
};

/* ───────────────── Registrar PAGO TOTAL ───────────────── */
/**
 * Registrar PAGO TOTAL de una cuota.
 *
 * - LIBRE:
 *      Liquida el crédito completo (interés del ciclo vigente + capital). Permite descuento opcional
 *      en % sobre el total (usar body.descuento como porcentaje). El monto se calcula internamente.
 *
 * - común/progresivo:
 *      Paga la cuota completa (mora + principal tras descuento opcional como MONTO).
 *
 * Body: { cuota_id, forma_pago_id, observacion?, descuento? }
 * Respuesta: { success, message, cuota, recibo, recibo_ui }
 */
export const registrarPagoTotal = async (req, res) => {
    try {
        let { cuota_id, forma_pago_id, observacion, descuento = 0 } = req.body ?? {};

        const cuotaIdInt = toIntOrNull(cuota_id);
        const formaPagoIdInt = toIntOrNull(forma_pago_id);

        if (!cuotaIdInt || !formaPagoIdInt) {
            return res.status(400).json({
                success: false,
                error: 'Faltan datos: cuota_id y forma_pago_id son obligatorios.'
            });
        }

        descuento = sanitizeNumber(descuento);
        if (descuento < 0) {
            return res.status(400).json({
                success: false,
                error: 'descuento no puede ser negativo.'
            });
        }

        // pagarCuota decide internamente modalidad y cálculo
        const { cuota, recibo } = await pagarCuota({
            cuota_id: cuotaIdInt,
            forma_pago_id: formaPagoIdInt,
            descuento,
            observacion
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
        res.status(500).json({
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
