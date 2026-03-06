// financiera-backend/services/cuota/cuota.mora.service.js
// Helpers de mora NO-LIBRE (aislado para mantener cuota.core liviano)

import { addDays, isAfter } from 'date-fns';
import { MORA_DIARIA, asYMD, ymd, ymdDate, todayYMD, fix2 } from './cuota.utils.js';

/**
 * Agrupa movimientos por día (NO libre)
 *
 * Soporta:
 * - pagos "planos": { monto_pagado, fecha_pago }
 * - pagos con recibo asociado:
 *   {
 *     monto_pagado,
 *     fecha_pago,
 *     recibo: { descuento_aplicado }
 *   }
 *
 * También tolera:
 * - p.recibo
 * - p.Recibo
 * - p.recibos[0]
 */
const prepararMovimientosPorDia = (pagos = []) => {
    const porDia = {};

    for (const p of pagos ?? []) {
        const fecha = asYMD(p?.fecha_pago || ymdDate(todayYMD()));

        const recibo =
            p?.recibo ??
            p?.Recibo ??
            (Array.isArray(p?.recibos) ? p.recibos[0] : null) ??
            null;

        const montoPagado = fix2(p?.monto_pagado ?? 0);
        const descuentoAplicado = fix2(recibo?.descuento_aplicado ?? 0);

        if (!porDia[fecha]) {
            porDia[fecha] = {
                pagado: 0,
                descuentoMora: 0
            };
        }

        porDia[fecha].pagado = fix2(porDia[fecha].pagado + montoPagado);
        porDia[fecha].descuentoMora = fix2(porDia[fecha].descuentoMora + descuentoAplicado);
    }

    return porDia;
};

/**
 * Simula mora día por día (NO libre)
 *
 * IMPORTANTE:
 * - El descuento de mora NO sale de cuota.descuento_cuota
 * - Sale del recibo asociado al pago (recibo.descuento_aplicado)
 *
 * Si no viene recibo asociado, la simulación se comporta como antes.
 */
export const simularMoraCuotaHasta = (cuota, pagos, hastaFecha = ymdDate(todayYMD())) => {
    if (!cuota) {
        return {
            moraPendiente: 0,
            principalPagadoHistorico: 0,
            saldoPrincipalPendiente: 0,
            totalMoraGenerada: 0,
            totalPagadoEnMoraHistorico: 0,
            totalDescuentoMoraHistorico: 0
        };
    }

    const importe = fix2(cuota.importe_cuota);
    const descuentoAcum = fix2(cuota.descuento_cuota);

    // 🔒 Comparaciones YMD: evitan mora el mismo día (todas en misma TZ)
    const dueY = ymd(cuota.fecha_vencimiento);
    const hastaY = ymd(hastaFecha);

    // Si hoy <= vencimiento → NO hay mora
    if (hastaY <= dueY) {
        const pagosAntes = (pagos ?? []).filter(
            p => ymd(p.fecha_pago || ymdDate(todayYMD())) <= dueY
        );

        const principalPrevio = fix2(
            pagosAntes.reduce((acc, p) => acc + fix2(p?.monto_pagado ?? 0), 0)
        );

        const saldo = Math.max(importe - descuentoAcum - principalPrevio, 0);

        return {
            moraPendiente: 0,
            principalPagadoHistorico: principalPrevio,
            saldoPrincipalPendiente: fix2(saldo),
            totalMoraGenerada: 0,
            totalPagadoEnMoraHistorico: 0,
            totalDescuentoMoraHistorico: 0
        };
    }

    const due = ymdDate(cuota.fecha_vencimiento);
    const hasta = ymdDate(hastaFecha);
    const movimientosPorDia = prepararMovimientosPorDia(pagos ?? []);

    const pagosHastaVenc = (pagos ?? []).filter(
        p => ymd(p.fecha_pago || ymdDate(todayYMD())) <= ymd(due)
    );

    let principalPagado = fix2(
        pagosHastaVenc.reduce((acc, p) => acc + fix2(p?.monto_pagado ?? 0), 0)
    );

    let moraAcum = 0;
    let totalMoraGenerada = 0;
    let totalMoraPagada = 0;
    let totalDescuentoMora = 0;

    // Arranca el día SIGUIENTE al vencimiento
    let cursor = addDays(due, 1);

    while (!isAfter(cursor, hasta)) {
        const fechaKey = asYMD(cursor);

        const saldoBase = Math.max(importe - descuentoAcum - principalPagado, 0);
        if (saldoBase <= 0) break;

        const moraDelDia = fix2(saldoBase * MORA_DIARIA);
        moraAcum = fix2(moraAcum + moraDelDia);
        totalMoraGenerada = fix2(totalMoraGenerada + moraDelDia);

        const mov = movimientosPorDia[fechaKey] ?? { pagado: 0, descuentoMora: 0 };
        const descuentoHoy = fix2(mov.descuentoMora ?? 0);
        const pagadoHoy = fix2(mov.pagado ?? 0);

        // 1) primero impacta el descuento sobre la mora acumulada
        if (descuentoHoy > 0) {
            const descAplicable = Math.min(descuentoHoy, moraAcum);
            moraAcum = fix2(moraAcum - descAplicable);
            totalDescuentoMora = fix2(totalDescuentoMora + descAplicable);
        }

        // 2) luego impacta el pago real
        if (pagadoHoy > 0) {
            const aMora = Math.min(pagadoHoy, moraAcum);
            moraAcum = fix2(moraAcum - aMora);
            totalMoraPagada = fix2(totalMoraPagada + aMora);

            const aPrincipal = Math.max(pagadoHoy - aMora, 0);
            if (aPrincipal > 0) {
                principalPagado = fix2(principalPagado + aPrincipal);
            }
        }

        cursor = addDays(cursor, 1);
    }

    const saldoPrincipalPendiente = Math.max(importe - descuentoAcum - principalPagado, 0);

    return {
        moraPendiente: fix2(Math.max(moraAcum, 0)),
        principalPagadoHistorico: fix2(principalPagado),
        saldoPrincipalPendiente: fix2(saldoPrincipalPendiente),
        totalMoraGenerada: fix2(totalMoraGenerada),
        totalPagadoEnMoraHistorico: fix2(totalMoraPagada),
        totalDescuentoMoraHistorico: fix2(totalDescuentoMora)
    };
};