// src/services/cuota.service.js

import Cuota from '../models/Cuota.js';
import FormaPago from '../models/FormaPago.js';
import Pago from '../models/Pago.js';
import Credito from '../models/Credito.js';
import Cliente from '../models/Cliente.js';
import Usuario from '../models/Usuario.js';
import Recibo from '../models/Recibo.js';
import {
    addDays,
    format,
    isAfter,
    differenceInCalendarDays,
    differenceInCalendarMonths
} from 'date-fns';
import { Op } from 'sequelize';
// ❌ Evitamos import estático para no crear dependencia circular con credito.service
// import { actualizarEstadoCredito } from './credito.service.js';
import sequelize from '../models/sequelize.js';
import { calcularPuntajeCliente } from './puntaje.service.js';

// ⬇️ NUEVO: impacto en caja
import CajaMovimiento from '../models/CajaMovimiento.js';

const MORA_DIARIA = 0.025; // 2,5% por día (NO aplica a "libre")
const VTO_FICTICIO_LIBRE = '2099-12-31';
const LIBRE_MAX_CICLOS = 3;

/* ───────────────── Helpers ───────────────── */
const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;
const asYMD = (d) => format(new Date(d), 'yyyy-MM-dd');

/** Normaliza tasa: admite 0.60 ó 60 => devuelve 0.60 */
const normalizeRate = (r) => {
    const n = toNumber(r);
    if (n <= 0) return 0;
    return n > 1 ? n / 100 : n;
};

const getPeriodDays = (tipo) => (tipo === 'semanal' ? 7 : tipo === 'quincenal' ? 15 : 30);

const esCreditoLibre = (credito) => String(credito?.modalidad_credito ?? '') === 'libre';

/** Ciclo LIBRE actual (mensual, máx. 3): 1, 2 o 3 */
const cicloLibreActual = (credito, refDate = new Date()) => {
    const baseYMD = credito?.fecha_acreditacion || credito?.fecha_compromiso_pago || asYMD(new Date());
    const [Y, M, D] = String(baseYMD).split('-').map((x) => parseInt(x, 10));
    const inicio = new Date(Y, (M || 1) - 1, D || 1);
    const diff = Math.max(differenceInCalendarMonths(refDate, inicio), 0);
    return Math.min(LIBRE_MAX_CICLOS, diff + 1);
};

/** Devuelve cantidad de ciclos completos transcurridos entre dos fechas (YMD) según periodicidad. */
const ciclosTranscurridos = (desdeYMD, hastaYMD, tipo_credito) => {
    const days = differenceInCalendarDays(new Date(hastaYMD), new Date(desdeYMD));
    const period = getPeriodDays(tipo_credito);
    if (days <= 0) return 0;
    return Math.floor(days / period);
};

/** Inicio del ciclo vigente a partir de una fecha base (acreditación o compromiso) y una fecha de referencia */
const inicioCicloVigente = (fechaBaseYMD, tipo_credito, refYMD) => {
    const base = new Date(fechaBaseYMD);
    const ref = new Date(refYMD);
    const period = getPeriodDays(tipo_credito);
    const days = Math.max(differenceInCalendarDays(ref, base), 0);
    const completos = Math.floor(days / period);
    return asYMD(addDays(base, completos * period));
};

/** Suma del interés de ciclo ya cobrado (recibos) dentro de un rango de fechas */
const interesCicloCobradoEnRango = async ({ cuota_id, desdeYMD, hastaYMD, t = null }) => {
    const recibos = await Recibo.findAll({
        attributes: ['interes_ciclo_cobrado', 'fecha'],
        where: {
            cuota_id,
            fecha: { [Op.gte]: desdeYMD, [Op.lte]: hastaYMD }
        },
        transaction: t
    });
    return fix2((recibos || []).reduce((acc, r) => acc + toNumber(r.interes_ciclo_cobrado), 0));
};

/**
 * Calcula el interés pendiente a cobrar hoy para un crédito LIBRE:
 *  - Interés de ciclos COMPLETOS desde el último pago (o acreditación/compromiso)
 *  - + FALTANTE del interés del ciclo ACTUAL (permite pago anticipado), evitando doble cobro
 */
const calcularInteresPendienteLibre = async ({ credito, cuota, hoyYMD, t = null }) => {
    const tasa = normalizeRate(credito.interes); // 0.60 si recibimos 60
    const saldo = fix2(credito.saldo_actual);
    if (saldo <= 0 || tasa <= 0) return 0;

    // Último pago de la cuota libre
    const ultimoPago = await Pago.findOne({
        where: { cuota_id: cuota.id },
        order: [['fecha_pago', 'DESC']],
        transaction: t
    });
    const baseInicio = credito.fecha_acreditacion || credito.fecha_compromiso_pago || hoyYMD;
    const fechaCorte = ultimoPago?.fecha_pago || baseInicio;

    // 1) Interés por ciclos COMPLETOS desde el corte hasta hoy
    const ciclosCompletos = ciclosTranscurridos(asYMD(fechaCorte), hoyYMD, credito.tipo_credito);
    const interesAtrasado = fix2(saldo * tasa * Math.max(ciclosCompletos, 0));

    // 2) FALTANTE del ciclo ACTUAL
    const iniCicloActual = inicioCicloVigente(baseInicio, credito.tipo_credito, hoyYMD);
    const yaCobradoEnCiclo = await interesCicloCobradoEnRango({
        cuota_id: cuota.id,
        desdeYMD: iniCicloActual,
        hastaYMD: hoyYMD,
        t
    });
    const interesCicloActualTotal = fix2(saldo * tasa);
    const faltanteCicloActual = Math.max(fix2(interesCicloActualTotal - yaCobradoEnCiclo), 0);

    return fix2(interesAtrasado + faltanteCicloActual);
};

/** Agrupa pagos por día => { 'yyyy-MM-dd': totalDelDía } (para mora de créditos NO libres) */
const prepararPagosPorDia = (pagos = []) => {
    const porDia = {};
    for (const p of pagos) {
        const fecha = asYMD(p.fecha_pago || new Date());
        porDia[fecha] = fix2(p.monto_pagado) + (porDia[fecha] ?? 0);
    }
    return porDia;
};

/**
 * Simula mora día por día (NO se usa para "libre").
 * Regla: en el día D primero se computa la mora del día y recién después se aplican los pagos de D.
 */
const simularMoraCuotaHasta = (cuota, pagos, hastaFecha = new Date()) => {
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
    const due = new Date(cuota.fecha_vencimiento);
    const hasta = new Date(asYMD(hastaFecha));

    // Si no está vencida aún para 'hasta', no hay mora
    if (!isAfter(hasta, due)) {
        const pagosAntes = (pagos ?? []).filter(
            p => !isAfter(new Date(p.fecha_pago || new Date()), due)
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

    const pagosPorDia = prepararPagosPorDia(pagos ?? []);

    // Pagos hasta el día de vencimiento inclusive
    const pagosHastaVenc = (pagos ?? []).filter(
        p => !isAfter(new Date(p.fecha_pago || new Date()), due)
    );
    let principalPagado = fix2(pagosHastaVenc.reduce((acc, p) => acc + fix2(p.monto_pagado), 0));

    let moraAcum = 0;
    let totalMoraGenerada = 0;
    let totalMoraPagada = 0;

    // Inicia el día siguiente al vencimiento
    let cursor = addDays(due, 1);

    while (!isAfter(cursor, hasta)) {
        const fechaKey = asYMD(cursor);

        // Mora del día ANTES de aplicar pagos del mismo día
        const saldoBase = Math.max(importe - descuentoAcum - principalPagado, 0);
        if (saldoBase <= 0) break;

        const moraDelDia = fix2(saldoBase * MORA_DIARIA);
        moraAcum = fix2(moraAcum + moraDelDia);
        totalMoraGenerada = fix2(totalMoraGenerada + moraDelDia);

        // Aplicar pagos del día: primero a mora, luego a principal
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

/* ───────── Caja: registrar ingreso desde un Recibo dentro de la misma TX ───────── */
const registrarIngresoDesdeReciboEnTx = async ({ t, recibo, forma_pago_id }) => {
    if (!recibo) return;
    const now = new Date();
    await CajaMovimiento.create({
        fecha: recibo.fecha || asYMD(now),
        hora: recibo.hora || format(now, 'HH:mm:ss'),
        tipo: 'ingreso',
        monto: fix2(recibo.monto_pagado || 0),
        forma_pago_id: forma_pago_id ?? null,
        concepto: (
            (recibo?.numero_recibo != null && recibo?.numero_recibo !== '')
                ? `Cobro recibo #${recibo.numero_recibo} - ${recibo?.cliente_nombre || 'Cliente'}`
                : `Cobro recibo - ${recibo?.cliente_nombre || 'Cliente'}`
        ).slice(0, 255),
        referencia_tipo: 'recibo',
        referencia_id: recibo.numero_recibo ?? null,
        usuario_id: null
    }, { transaction: t });
};

/* ───────────────── Vencimientos ───────────────── */
export const actualizarCuotasVencidas = async () => {
    const hoy = asYMD(new Date());

    // IDs de créditos "libre" para excluirlos
    const libres = await Credito.findAll({
        attributes: ['id'],
        where: { modalidad_credito: 'libre' },
        raw: true
    });
    const libreIds = libres.map(r => r.id);

    // IDs de créditos refinanciados para excluirlos
    const refinanciados = await Credito.findAll({
        attributes: ['id'],
        where: { estado: 'refinanciado' },
        raw: true
    });
    const refiIds = refinanciados.map(r => r.id);

    // Actualizar sólo cuotas NO libres/refinanciadas y que no tengan el vencimiento ficticio
    const whereUpdate = {
        estado: { [Op.in]: ['pendiente', 'parcial'] },
        fecha_vencimiento: { [Op.lt]: hoy, [Op.ne]: VTO_FICTICIO_LIBRE }
    };
    const excluir = [...libreIds, ...refiIds];
    if (excluir.length > 0) {
        whereUpdate['credito_id'] = { [Op.notIn]: excluir };
    }

    const [total_actualizadas] = await Cuota.update(
        { estado: 'vencida' },
        { where: whereUpdate }
    );

    if (total_actualizadas > 0) {
        const creditosIds = await Cuota.findAll({
            attributes: ['credito_id'],
            where: { estado: 'vencida', fecha_vencimiento: { [Op.lt]: hoy, [Op.ne]: VTO_FICTICIO_LIBRE } },
            group: ['credito_id'],
            raw: true
        }).then(rows => rows.map(r => r.credito_id));

        // ✅ import dinámico para evitar circularidad
        const { actualizarEstadoCredito } = await import('./credito.service.js');
        for (const creditoId of creditosIds) {
            await actualizarEstadoCredito(creditoId);
        }
    }
    return total_actualizadas;
};

/* ───────────────── Mora: recalcular (idempotente) ───────────────── */
export const recalcularMoraCuota = async (cuotaId, t = null) => {
    const cuota = await Cuota.findByPk(cuotaId, {
        include: [
            {
                model: Pago,
                as: 'pagos',
                attributes: ['id', 'monto_pagado', 'fecha_pago']
            }
        ],
        transaction: t
    });
    if (!cuota) throw new Error('Cuota no encontrada');

    // Si la cuota pertenece a un crédito "libre" o "refinanciado", no hay mora
    const credito = await Credito.findByPk(cuota.credito_id, { transaction: t });
    if (!credito) throw new Error('Crédito asociado no encontrado');

    if (esCreditoLibre(credito) || cuota.fecha_vencimiento === VTO_FICTICIO_LIBRE || String(credito.estado) === 'refinanciado') {
        if (cuota.intereses_vencidos_acumulados !== 0) {
            await cuota.update({ intereses_vencidos_acumulados: 0 }, { transaction: t });
        }
        return 0;
    }

    if (cuota.estado === 'pagada') {
        await cuota.update({ intereses_vencidos_acumulados: 0 }, { transaction: t });
        return 0;
    }

    const { moraPendiente } = simularMoraCuotaHasta(cuota, cuota.pagos, new Date());
    await cuota.update({ intereses_vencidos_acumulados: moraPendiente }, { transaction: t });
    return moraPendiente;
};

export const recalcularMoraPorCredito = async (creditoId, t = null) => {
    const credito = await Credito.findByPk(creditoId, { transaction: t });
    if (!credito) throw new Error('Crédito no encontrado');

    if (esCreditoLibre(credito) || String(credito.estado) === 'refinanciado') {
        await Cuota.update(
            { intereses_vencidos_acumulados: 0 },
            { where: { credito_id: creditoId }, transaction: t }
        );
        return 0;
    }

    const cuotas = await Cuota.findAll({
        where: { credito_id: creditoId },
        include: [{ model: Pago, as: 'pagos', attributes: ['id', 'monto_pagado', 'fecha_pago'] }],
        transaction: t
    });

    let total = 0;
    for (const c of cuotas) {
        const { moraPendiente } = simularMoraCuotaHasta(c, c.pagos, new Date());
        await c.update({ intereses_vencidos_acumulados: moraPendiente }, { transaction: t });
        total = fix2(total + moraPendiente);
    }
    return total;
};

/* ───────────────── CRUD/Queries ───────────────── */
export const obtenerCuotas = async () => {
    await actualizarCuotasVencidas();

    const vencidas = await Cuota.findAll({ attributes: ['id'], where: { estado: 'vencida' } });
    for (const v of vencidas) {
        await recalcularMoraCuota(v.id);
    }

    return Cuota.findAll({
        include: [{ model: FormaPago, attributes: ['nombre'], as: 'formaPago' }],
        order: [['fecha_vencimiento', 'ASC'], ['numero_cuota', 'ASC']]
    });
};

export const actualizarCuota = async (id, data) => {
    const cuota = await Cuota.findByPk(id);
    if (!cuota) return null;
    await cuota.update(data);
    return cuota;
};

export const obtenerCuotaPorId = async (id) => {
    await actualizarCuotasVencidas();
    await recalcularMoraCuota(id);
    return Cuota.findByPk(id, {
        include: [{ model: FormaPago, attributes: ['nombre'], as: 'formaPago' }]
    });
};

export const obtenerCuotasPorCredito = async (creditoId) => {
    await actualizarCuotasVencidas();
    await recalcularMoraPorCredito(creditoId);
    return Cuota.findAll({
        where: { credito_id: creditoId },
        include: [
            { model: FormaPago, attributes: ['nombre'], as: 'formaPago' },
            {
                model: Pago,
                as: 'pagos',
                attributes: ['id', 'monto_pagado', 'fecha_pago'],
                include: [{ model: FormaPago, as: 'formaPago', attributes: ['nombre'] }]
            }
        ],
        order: [['numero_cuota', 'ASC']]
    });
};

/**
 * NUEVO: Listado de cuotas vencidas (para notificaciones/tabla)
 * Filtros: clienteId, cobradorId, zonaId, desde, hasta, minDiasVencida
 * Devuelve filas listas para UI con cliente, montos y totales del día.
 */
export const obtenerCuotasVencidas = async (query = {}) => {
    // 1) Asegurar que estados/fechas estén al día
    await actualizarCuotasVencidas();

    const hoy = new Date();
    const hoyYMD = asYMD(hoy);

    // 2) Construir where base (solo vencidas y no ficticias)
    const whereCuota = {
        estado: 'vencida',
        fecha_vencimiento: { [Op.lt]: hoyYMD, [Op.ne]: VTO_FICTICIO_LIBRE }
    };

    // Rango de fechas opcional
    const desde = query.desde ? asYMD(query.desde) : null;
    const hasta = query.hasta ? asYMD(query.hasta) : null;
    if (desde && hasta) {
        whereCuota.fecha_vencimiento = { [Op.gte]: desde, [Op.lte]: hasta, [Op.ne]: VTO_FICTICIO_LIBRE };
    } else if (desde) {
        whereCuota.fecha_vencimiento = { [Op.gte]: desde, [Op.lt]: hoyYMD, [Op.ne]: VTO_FICTICIO_LIBRE };
    } else if (hasta) {
        whereCuota.fecha_vencimiento = { [Op.lte]: hasta, [Op.ne]: VTO_FICTICIO_LIBRE };
    }

    // 3) Traer cuotas + pagos para simular mora
    const cuotas = await Cuota.findAll({
        where: whereCuota,
        attributes: [
            'id',
            'credito_id',
            'numero_cuota',
            'fecha_vencimiento',
            'importe_cuota',
            'descuento_cuota',
            'monto_pagado_acumulado'
        ],
        include: [{
            model: Pago,
            as: 'pagos',
            attributes: ['monto_pagado', 'fecha_pago']
        }],
        order: [['fecha_vencimiento', 'ASC']]
    });

    if (cuotas.length === 0) return [];

    // 4) Cargar créditos relacionados (para filtros y excluir 'libre'/'refinanciado')
    const creditoIds = [...new Set(cuotas.map(c => c.credito_id))];
    const creditos = await Credito.findAll({
        where: { id: { [Op.in]: creditoIds } },
        attributes: [
            'id',
            'cliente_id',
            'cobrador_id',
            'modalidad_credito',
            'estado',
            'tipo_credito',
            'interes',
            'saldo_actual',
            'fecha_acreditacion',
            'fecha_compromiso_pago'
        ]
    });
    const mapCredito = new Map(creditos.map(cr => [cr.id, cr]));

    // 5) Cargar clientes (para nombre/apellido y filtro por zona)
    const clienteIds = [...new Set(creditos.map(cr => cr.cliente_id))];
    const clientes = await Cliente.findAll({
        where: { id: { [Op.in]: clienteIds } },
        attributes: ['id', 'nombre', 'apellido', 'zona'] // zona: según tu modelo Cliente
    });
    const mapCliente = new Map(clientes.map(cl => [cl.id, cl]));

    // 6) Filtros por query (cliente, cobrador, zona, minDiasVencida)
    const clienteId = query.clienteId ? Number(query.clienteId) : null;
    const cobradorId = query.cobradorId ? Number(query.cobradorId) : null;
    const zonaId = query.zonaId ?? null; // según tu modelo, Cliente.zona
    const minDiasVencida = query.minDiasVencida ? Number(query.minDiasVencida) : null;

    // 7) Armar filas con simulación de mora/saldo
    const filas = [];
    for (const c of cuotas) {
        const cr = mapCredito.get(c.credito_id);
        if (!cr) continue;

        // Excluir libre y refinanciado por seguridad
        if (esCreditoLibre(cr) || String(cr.estado) === 'refinanciado') continue;

        const cl = mapCliente.get(cr.cliente_id);
        if (!cl) continue;

        // Filtros en memoria (evita asumir alias en Sequelize)
        if (clienteId && cl.id !== clienteId) continue;
        if (cobradorId && cr.cobrador_id !== cobradorId) continue;
        if (zonaId != null && String(cl.zona ?? '') !== String(zonaId)) continue;

        const diasVencida = differenceInCalendarDays(hoy, new Date(c.fecha_vencimiento));
        if (minDiasVencida && diasVencida < minDiasVencida) continue;

        const sim = simularMoraCuotaHasta(c, c.pagos, hoy);

        const mora_pendiente = fix2(sim.moraPendiente);
        const saldo_principal_pendiente = fix2(sim.saldoPrincipalPendiente);
        const total_a_pagar_hoy = fix2(mora_pendiente + saldo_principal_pendiente);

        filas.push({
            cuota_id: c.id,
            credito_id: c.credito_id,
            numero_cuota: c.numero_cuota,
            fecha_vencimiento: asYMD(c.fecha_vencimiento),
            cliente: {
                id: cl.id,
                nombre: cl.nombre,
                apellido: cl.apellido
            },
            importe_cuota: fix2(c.importe_cuota),
            descuento_cuota: fix2(c.descuento_cuota),
            monto_pagado_acumulado: fix2(c.monto_pagado_acumulado),
            mora_pendiente,
            saldo_principal_pendiente,
            total_a_pagar_hoy: fix2(total_a_pagar_hoy),
            dias_vencida: diasVencida
        });
    }

    // 8) Orden final por vencimiento ASC (ya viene así, por las dudas)
    filas.sort((a, b) => (a.fecha_vencimiento < b.fecha_vencimiento ? -1 : a.fecha_vencimiento > b.fecha_vencimiento ? 1 : 0));

    return filas;
};

/* ───────────────── Recibos ───────────────── */
const armarDatosRecibo = ({
    cliente,
    cobrador,
    pago,
    cuota,
    credito,
    medioPagoNombre,
    importeOriginalCuota,
    descuentoAplicado,
    moraCobrada,
    principalPagado,
    saldoPrincipalAntes,
    saldoPrincipalDespues,
    saldoCreditoAntes,
    saldoCreditoDespues,
    conceptoExtra = '',
    interesCicloCobrado = 0,
    // saldoCuotaAnterior / saldoCuotaActual **solo** para cálculo; se reflejan en saldo_anterior/actual
    saldoCuotaAnterior = undefined,
    saldoCuotaActual = undefined
}) => {
    return {
        cliente_id: cliente.id,
        pago_id: pago.id,
        cuota_id: cuota.id,
        cliente_nombre: `${cliente.nombre} ${cliente.apellido}`,
        monto_pagado: fix2(pago.monto_pagado),
        concepto: conceptoExtra || `Pago cuota #${cuota.numero_cuota} del crédito #${credito.id}`,
        fecha: format(new Date(), 'yyyy-MM-dd'),
        hora: format(new Date(), 'HH:mm:ss'),
        // Los saldos de "cuota" se reflejan en los campos **existentes** del modelo:
        saldo_anterior: fix2(
            typeof saldoCuotaAnterior === 'number' ? saldoCuotaAnterior : saldoPrincipalAntes
        ),
        pago_a_cuenta: fix2(pago.monto_pagado),
        saldo_actual: fix2(
            typeof saldoCuotaActual === 'number' ? saldoCuotaActual : saldoPrincipalDespues
        ),
        nombre_cobrador: cobrador?.nombre_completo || 'Sin cobrador asignado',
        medio_pago: medioPagoNombre,
        // Desglose/Detalle
        importe_cuota_original: fix2(importeOriginalCuota),
        descuento_aplicado: fix2(descuentoAplicado),
        mora_cobrada: fix2(moraCobrada),
        principal_pagado: fix2(principalPagado),
        // Saldos del crédito (no de la cuota)
        saldo_credito_anterior: fix2(saldoCreditoAntes),
        saldo_credito_actual: fix2(saldoCreditoDespues),
        // Interés de ciclo (LIBRE)
        interes_ciclo_cobrado: fix2(interesCicloCobrado)
    };
};

/* ───────────────── Pagos ───────────────── */
export const pagarCuota = async (...args) => {
    if (args.length && typeof args[0] !== 'object') {
        const [cuotaId, formaPagoId, observacion = null] = args;
        return pagarCuotaTotal({
            cuota_id: cuotaId,
            forma_pago_id: formaPagoId,
            descuento: 0,
            observacion
        });
    }
    return pagarCuotaTotal(args[0]);
};

const pagarCuotaTotal = async ({
    cuota_id,
    forma_pago_id,
    descuento = 0,
    observacion = null
}) => {
    const t = await sequelize.transaction();
    try {
        const cuota = await Cuota.findByPk(cuota_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (!cuota) throw new Error('Cuota no encontrada');

        // 🔒 Bloqueo del crédito también (evita carreras con otros pagos)
        const credito = await Credito.findByPk(cuota.credito_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!credito) throw new Error('Crédito asociado no encontrado');

        const cliente = await Cliente.findByPk(credito.cliente_id, { transaction: t });
        const cobrador = await Usuario.findByPk(credito.cobrador_id, { transaction: t });
        const medioPago = await FormaPago.findByPk(forma_pago_id, { transaction: t });

        // —— LIBRE → Liquidación total —— 
        if (esCreditoLibre(credito)) {
            const hoyYMD = asYMD(new Date());
            const interesPendiente = await calcularInteresPendienteLibre({ credito, cuota, hoyYMD, t });
            const saldo = fix2(credito.saldo_actual);

            const totalBase = fix2(saldo + interesPendiente);
            const pct = Math.min(Math.max(fix2(descuento), 0), 100);
            const descuentoMonto = fix2(totalBase * (pct / 100));
            const totalAPagar = fix2(totalBase - descuentoMonto);

            const pago = await Pago.create(
                { cuota_id, monto_pagado: totalAPagar, forma_pago_id, observacion, fecha_pago: hoyYMD },
                { transaction: t }
            );

            await cuota.update({
                estado: 'pagada',
                forma_pago_id,
                descuento_cuota: fix2(toNumber(cuota.descuento_cuota)),
                monto_pagado_acumulado: fix2(cuota.importe_cuota),
                intereses_vencidos_acumulados: 0
            }, { transaction: t });

            const saldoAntes = fix2(credito.saldo_actual);
            await credito.update({
                saldo_actual: 0,
                estado: 'pagado',
                interes_acumulado: fix2(toNumber(credito.interes_acumulado) + interesPendiente)
            }, { transaction: t });

            const saldoCuotaAnterior = fix2(saldoAntes + interesPendiente);
            const saldoCuotaActual = 0;

            const recibo = await Recibo.create(armarDatosRecibo({
                cliente,
                cobrador,
                pago,
                cuota,
                credito,
                medioPagoNombre: medioPago?.nombre ?? 'N/D',
                importeOriginalCuota: cuota.importe_cuota,
                descuentoAplicado: descuentoMonto,
                moraCobrada: 0,
                principalPagado: saldo,
                saldoPrincipalAntes: saldoCuotaAnterior,
                saldoPrincipalDespues: saldoCuotaActual,
                saldoCreditoAntes: saldoAntes,
                saldoCreditoDespues: 0,
                conceptoExtra: `Liquidación crédito LIBRE #${credito.id}`,
                interesCicloCobrado: interesPendiente,
                saldoCuotaAnterior,
                saldoCuotaActual
            }), { transaction: t });

            // ⬇️ CAJA (ingreso por recibo)
            await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id });

            // ✅ import dinámico para evitar circularidad
            const { actualizarEstadoCredito } = await import('./credito.service.js');
            await actualizarEstadoCredito(credito.id, t);
            await t.commit();
            await calcularPuntajeCliente(cliente.id);

            return { cuota, recibo };
        }

        // —— NO libre —— 
        const moraActual = await recalcularMoraCuota(cuota.id, t);

        const importeOriginal = fix2(cuota.importe_cuota);
        const descuentoPrevio = fix2(cuota.descuento_cuota);
        const principalPagadoPrevio = fix2(cuota.monto_pagado_acumulado);

        const saldoPrincipalAntes = Math.max(importeOriginal - descuentoPrevio - principalPagadoPrevio, 0);
        const saldoCreditoAntes = fix2(credito.saldo_actual);

        const descuentoAplicado = Math.min(Math.max(fix2(descuento), 0), saldoPrincipalAntes);
        const nuevoDescuentoAcum = fix2(descuentoPrevio + descuentoAplicado);

        const saldoPrincipalTrasDescuento = Math.max(importeOriginal - nuevoDescuentoAcum - principalPagadoPrevio, 0);

        const netoAPagar = fix2(moraActual + saldoPrincipalTrasDescuento);

        const pago = await Pago.create(
            { cuota_id, monto_pagado: netoAPagar, forma_pago_id, observacion, fecha_pago: asYMD(new Date()) },
            { transaction: t }
        );

        const moraCobrada = Math.min(netoAPagar, moraActual);
        const principalPagado = Math.max(netoAPagar - moraCobrada, 0);

        // 🔧 FIX: usar 'moraCobrada' (no 'aMora')
        cuota.intereses_vencidos_acumulados = fix2(Math.max(moraActual - moraCobrada, 0));
        cuota.monto_pagado_acumulado = fix2(principalPagadoPrevio + principalPagado);
        cuota.descuento_cuota = nuevoDescuentoAcum;
        cuota.estado = 'pagada';
        cuota.forma_pago_id = forma_pago_id;
        await cuota.save({ transaction: t });

        credito.interes_acumulado = fix2(toNumber(credito.interes_acumulado) + moraCobrada);
        credito.saldo_actual = fix2(Math.max(toNumber(credito.saldo_actual) - principalPagado, 0));
        await credito.save({ transaction: t });

        const recibo = await Recibo.create(armarDatosRecibo({
            cliente,
            cobrador,
            pago,
            cuota,
            credito,
            medioPagoNombre: medioPago?.nombre ?? 'N/D',
            importeOriginalCuota: importeOriginal,
            descuentoAplicado,
            moraCobrada,
            principalPagado,
            saldoPrincipalAntes,
            saldoPrincipalDespues: 0,
            saldoCreditoAntes,
            saldoCreditoDespues: toNumber(credito.saldo_actual),
            interesCicloCobrado: 0
        }), { transaction: t });

        // ⬇️ CAJA (ingreso por recibo)
        await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id });

        const { actualizarEstadoCredito } = await import('./credito.service.js');
        await actualizarEstadoCredito(credito.id, t);
        await t.commit();

        await calcularPuntajeCliente(cliente.id);

        return { cuota, recibo };
    } catch (err) {
        await t.rollback();
        throw err;
    }
};

export const registrarPagoParcial = async ({
    cuota_id,
    monto_pagado,
    forma_pago_id,
    observacion = null,
    descuento = 0
}) => {
    const t = await sequelize.transaction();
    try {
        if (toNumber(monto_pagado) <= 0) throw new Error('monto_pagado debe ser > 0');

        const cuota = await Cuota.findByPk(cuota_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (!cuota) throw new Error('Cuota no encontrada');

        // 🔒 Bloqueo del crédito también (evita carreras con otros pagos)
        const credito = await Credito.findByPk(cuota.credito_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!credito) throw new Error('Crédito asociado no encontrado');

        const cliente = await Cliente.findByPk(credito.cliente_id, { transaction: t });
        const cobrador = await Usuario.findByPk(credito.cobrador_id, { transaction: t });
        const medioPago = await FormaPago.findByPk(forma_pago_id, { transaction: t });

        const hoyYMD = asYMD(new Date());

        // —— LIBRE → pago parcial: interés y luego capital —— 
        if (esCreditoLibre(credito)) {
            const ciclo = cicloLibreActual(credito, new Date());
            if (ciclo >= LIBRE_MAX_CICLOS) {
                throw new Error('En el 3er mes del crédito LIBRE no se permite pago parcial. Debe registrar pago total (cancelación del crédito).');
            }

            const interesPendienteBefore = await calcularInteresPendienteLibre({ credito, cuota, hoyYMD, t });
            const pagado = fix2(monto_pagado);
            const aInteres = Math.min(pagado, interesPendienteBefore);
            const aCapital = Math.max(pagado - aInteres, 0);
            const saldoAntes = fix2(credito.saldo_actual);
            const nuevoSaldo = fix2(Math.max(saldoAntes - aCapital, 0));
            const interesPendienteAfter = fix2(Math.max(interesPendienteBefore - aInteres, 0));

            const pago = await Pago.create(
                { cuota_id, monto_pagado: pagado, forma_pago_id, observacion, fecha_pago: hoyYMD },
                { transaction: t }
            );

            const nuevaEstado = nuevoSaldo > 0 ? 'parcial' : 'pagada';
            await cuota.update({
                estado: nuevaEstado,
                forma_pago_id,
                intereses_vencidos_acumulados: 0
            }, { transaction: t });

            await credito.update({
                saldo_actual: nuevoSaldo,
                interes_acumulado: fix2(toNumber(credito.interes_acumulado) + aInteres),
                estado: nuevoSaldo === 0 ? 'pagado' : credito.estado
            }, { transaction: t });

            const saldoCuotaAnterior = fix2(saldoAntes + interesPendienteBefore);
            const saldoCuotaActual = fix2(nuevoSaldo + interesPendienteAfter);

            const recibo = await Recibo.create(armarDatosRecibo({
                cliente,
                cobrador,
                pago,
                cuota,
                credito,
                medioPagoNombre: medioPago?.nombre ?? 'N/D',
                importeOriginalCuota: cuota.importe_cuota,
                descuentoAplicado: 0,
                moraCobrada: 0,
                principalPagado: aCapital,
                saldoPrincipalAntes: saldoCuotaAnterior,
                saldoPrincipalDespues: saldoCuotaActual,
                saldoCreditoAntes: saldoAntes,
                saldoCreditoDespues: nuevoSaldo,
                conceptoExtra: `Pago parcial crédito LIBRE #${credito.id}`,
                interesCicloCobrado: aInteres,
                saldoCuotaAnterior,
                saldoCuotaActual
            }), { transaction: t });

            // ⬇️ CAJA (ingreso por recibo)
            await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id });

            const { actualizarEstadoCredito } = await import('./credito.service.js');
            await actualizarEstadoCredito(credito.id, t);
            await t.commit();

            await calcularPuntajeCliente(credito.cliente_id);

            return { cuota, recibo };
        }

        // —— NO libre —— 
        const moraActual = await recalcularMoraCuota(cuota.id, t);

        const importeCuota = fix2(cuota.importe_cuota);
        const descuentoPrevio = fix2(cuota.descuento_cuota);
        const principalPagadoPrevio = fix2(cuota.monto_pagado_acumulado);
        const saldoPrincipalAntes = Math.max(importeCuota - descuentoPrevio - principalPagadoPrevio, 0);
        const saldoCreditoAntes = fix2(credito.saldo_actual);

        const descuentoAplicado = Math.min(Math.max(fix2(descuento), 0), saldoPrincipalAntes);
        const nuevoDescuentoAcum = fix2(descuentoPrevio + descuentoAplicado);
        const saldoPrincipalTrasDescuento = Math.max(importeCuota - nuevoDescuentoAcum - principalPagadoPrevio, 0);

        const pago = await Pago.create(
            { cuota_id, monto_pagado: fix2(monto_pagado), forma_pago_id, observacion, fecha_pago: hoyYMD },
            { transaction: t }
        );

        const aMora = Math.min(fix2(monto_pagado), moraActual);
        const aPrincipal = Math.max(fix2(monto_pagado) - aMora, 0);
        const principalEfectivo = Math.min(aPrincipal, saldoPrincipalTrasDescuento);

        cuota.intereses_vencidos_acumulados = fix2(Math.max(moraActual - aMora, 0));
        cuota.monto_pagado_acumulado = fix2(principalPagadoPrevio + principalEfectivo);
        cuota.descuento_cuota = nuevoDescuentoAcum;

        const principalPendienteDespues = Math.max(
            importeCuota - cuota.descuento_cuota - cuota.monto_pagado_acumulado,
            0
        );

        if (principalPendienteDespues <= 0 && cuota.intereses_vencidos_acumulados <= 0) {
            cuota.estado = 'pagada';
        } else if (['pendiente', 'parcial', 'vencida'].includes(cuota.estado)) {
            cuota.estado = principalEfectivo > 0 ? 'parcial' : cuota.estado;
        }

        // Reprogramación de vencimiento opcional (si cubrió interés original)
        const tasa = normalizeRate(credito.interes);
        const principalOriginal = importeCuota / (1 + tasa);
        const interesPorCuota = importeCuota - principalOriginal;

        if (principalEfectivo >= interesPorCuota) {
            const base = new Date(cuota.fecha_vencimiento);
            const delta =
                credito.tipo_credito === 'semanal' ? 7 :
                credito.tipo_credito === 'quincenal' ? 15 : 30;
            cuota.fecha_vencimiento = format(addDays(base, delta), 'yyyy-MM-dd');
            if (cuota.estado === 'vencida') cuota.estado = 'pendiente';
        }

        await cuota.save({ transaction: t });

        credito.interes_acumulado = fix2(toNumber(credito.interes_acumulado) + aMora);
        credito.saldo_actual = fix2(Math.max(toNumber(credito.saldo_actual) - principalEfectivo, 0));
        await credito.save({ transaction: t });

        const recibo = await Recibo.create(armarDatosRecibo({
            cliente,
            cobrador,
            pago,
            cuota,
            credito,
            medioPagoNombre: medioPago?.nombre ?? 'N/D',
            importeOriginalCuota: importeCuota,
            descuentoAplicado,
            moraCobrada: aMora,
            principalPagado: principalEfectivo,
            saldoPrincipalAntes,
            saldoPrincipalDespues: fix2(principalPendienteDespues),
            saldoCreditoAntes,
            saldoCreditoDespues: toNumber(credito.saldo_actual),
            interesCicloCobrado: 0
        }), { transaction: t });

        // ⬇️ CAJA (ingreso por recibo)
        await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id });

        const { actualizarEstadoCredito } = await import('./credito.service.js');
        await actualizarEstadoCredito(cuota.credito_id, t);
        await t.commit();

        await calcularPuntajeCliente(credito.cliente_id);

        return { cuota, recibo };
    } catch (err) {
        await t.rollback();
        throw err;
    }
};

/* ───────────────── Soporte a rutas existentes ───────────────── */
export const crearCuota = async (data) => {
    const cuota = await Cuota.create(data);
    return cuota;
};

export const eliminarCuota = async (id) => {
    const t = await sequelize.transaction();
    try {
        const cuota = await Cuota.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!cuota) {
            await t.rollback();
            return false;
        }

        // Si hay pagos asociados, no permitimos borrar (evita desbalance en caja/recibos)
        const tienePagos = await Pago.count({ where: { cuota_id: id }, transaction: t });
        if (tienePagos > 0) {
            await t.rollback();
            const err = new Error('No se puede eliminar la cuota: tiene pagos registrados.');
            err.status = 409;
            throw err;
        }

        // Limpieza defensiva: recibos “suelto” por esa cuota (y sus movimientos de caja)
        const recibos = await Recibo.findAll({
            where: { cuota_id: id },
            attributes: ['numero_recibo'],
            transaction: t
        });
        const numerosRecibo = recibos.map(r => r.numero_recibo);

        if (numerosRecibo.length > 0) {
            await CajaMovimiento.destroy({
                where: { referencia_tipo: 'recibo', referencia_id: { [Op.in]: numerosRecibo } },
                transaction: t
            });
            // 🔧 FIX: borrar por numero_recibo (no por id)
            await Recibo.destroy({
                where: { numero_recibo: { [Op.in]: numerosRecibo } },
                transaction: t
            });
        }

        await cuota.destroy({ transaction: t });
        await t.commit();
        return true;
    } catch (e) {
        if (t.finished !== 'commit') {
            try { await t.rollback(); } catch (_) {}
        }
        throw e;
    }
};

/* ───────────────── Resumen LIBRE ───────────────── */
export const obtenerResumenLibrePorCredito = async (creditoId, fecha = new Date()) => {
    const credito = await Credito.findByPk(creditoId);
    if (!credito) throw new Error('Crédito no encontrado');
    if (!esCreditoLibre(credito)) {
        return {
            credito_id: credito.id,
            saldo_capital: fix2(credito.saldo_actual),
            interes_pendiente_hoy: 0,
            total_liquidacion_hoy: fix2(credito.saldo_actual),
            tasa_decimal: normalizeRate(credito.interes),
            hoy: asYMD(fecha)
        };
    }
    const cuota = await Cuota.findOne({ where: { credito_id: creditoId }, order: [['numero_cuota', 'ASC']] });
    if (!cuota) throw new Error('No se encontró cuota abierta del crédito libre');

    const hoyYMD = asYMD(fecha);
    const interesPendiente = await calcularInteresPendienteLibre({ credito, cuota, hoyYMD });
    const saldo = fix2(credito.saldo_actual);

    return {
        credito_id: credito.id,
        saldo_capital: saldo,
        interes_pendiente_hoy: fix2(interesPendiente),
        total_liquidacion_hoy: fix2(saldo + interesPendiente),
        tasa_decimal: normalizeRate(credito.interes),
        hoy: hoyYMD,
        ciclo_actual: cicloLibreActual(credito, fecha)
    };
};
