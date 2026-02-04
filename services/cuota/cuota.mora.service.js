// financiera-backend/services/cuota/cuota.mora.service.js
// Helpers de mora NO-LIBRE (aislado para mantener cuota.core liviano)

import { addDays, isAfter } from 'date-fns';
import { MORA_DIARIA, asYMD, ymd, ymdDate, todayYMD, fix2 } from './cuota.utils.js';

/** Agrupa pagos por día (NO libre) */
const prepararPagosPorDia = (pagos = []) => {
    const porDia = {};
    for (const p of pagos) {
        const fecha = asYMD(p.fecha_pago || ymdDate(todayYMD()));
        porDia[fecha] = fix2(p.monto_pagado) + (porDia[fecha] ?? 0);
    }
    return porDia;
};

/** Simula mora día por día (NO libre) */
export const simularMoraCuotaHasta = (cuota, pagos, hastaFecha = ymdDate(todayYMD())) => {
    if (!cuota) {
        return {
            moraPendiente: 0,
            principalPagadoHistorico: 0,
            saldoPrincipalPendiente: 0,
            totalMoraGenerada: 0,
            totalPagadoEnMoraHistorico: 0
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
        const principalPrevio = fix2(pagosAntes.reduce((acc, p) => acc + fix2(p.monto_pagado), 0));
        const saldo = Math.max(importe - descuentoAcum - principalPrevio, 0);
        return {
            moraPendiente: 0,
            principalPagadoHistorico: principalPrevio,
            saldoPrincipalPendiente: fix2(saldo),
            totalMoraGenerada: 0,
            totalPagadoEnMoraHistorico: 0
        };
    }

    const due = ymdDate(cuota.fecha_vencimiento);
    const hasta = ymdDate(hastaFecha);
    const pagosPorDia = prepararPagosPorDia(pagos ?? []);

    const pagosHastaVenc = (pagos ?? []).filter(
        p => ymd(p.fecha_pago || ymdDate(todayYMD())) <= ymd(due)
    );
    let principalPagado = fix2(pagosHastaVenc.reduce((acc, p) => acc + fix2(p.monto_pagado), 0));

    let moraAcum = 0;
    let totalMoraGenerada = 0;
    let totalMoraPagada = 0;

    // Arranca el día SIGUIENTE al vencimiento
    let cursor = addDays(due, 1);

    while (!isAfter(cursor, hasta)) {
        const fechaKey = asYMD(cursor);

        const saldoBase = Math.max(importe - descuentoAcum - principalPagado, 0);
        if (saldoBase <= 0) break;

        const moraDelDia = fix2(saldoBase * MORA_DIARIA);
        moraAcum = fix2(moraAcum + moraDelDia);
        totalMoraGenerada = fix2(totalMoraGenerada + moraDelDia);

        const pagadoHoy = fix2(pagosPorDia[fechaKey] ?? 0);
        if (pagadoHoy > 0) {
            const aMora = Math.min(pagadoHoy, moraAcum);
            moraAcum = fix2(moraAcum - aMora);
            totalMoraPagada = fix2(totalMoraPagada + aMora);

            const aPrincipal = Math.max(pagadoHoy - aMora, 0);
            if (aPrincipal > 0) principalPagado = fix2(principalPagado + aPrincipal);
        }

        cursor = addDays(cursor, 1);
    }

    const saldoPrincipalPendiente = Math.max(importe - descuentoAcum - principalPagado, 0);
    return {
        moraPendiente: fix2(Math.max(moraAcum, 0)),
        principalPagadoHistorico: fix2(principalPagado),
        saldoPrincipalPendiente: fix2(saldoPrincipalPendiente),
        totalMoraGenerada: fix2(totalMoraGenerada),
        totalPagadoEnMoraHistorico: fix2(totalMoraPagada)
    };
};