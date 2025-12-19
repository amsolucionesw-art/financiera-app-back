// backend/src/services/cuota.service.js
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

// ⬇️ Impacto en caja
import CajaMovimiento from '../models/CajaMovimiento.js';

/* ===================== Constantes ===================== */
const MORA_DIARIA = 0.025;              // 2,5% por día (NO libre)
const MORA_DIARIA_LIBRE = 0.025;        // 2,5% por día sobre el INTERÉS del mes (LIBRE)
const VTO_FICTICIO_LIBRE = '2099-12-31';
const LIBRE_MAX_CICLOS = 3;

/* ===================== Zona horaria (Tucumán) ===================== */
/** Timezone de referencia de negocio. Podés sobreescribir con APP_TZ. */
const APP_TZ = process.env.APP_TZ || 'America/Argentina/Tucuman';

/* === Helpers de TZ (consistentes) === */

/** Devuelve YYYY-MM-DD en la TZ del negocio para una fecha dada (o now). */
const toYMD_TZ = (d = new Date()) => {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: APP_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);
};

/** Devuelve Date “fecha-solo” (00:00 local **independiente del APP_TZ**) a partir de 'YYYY-MM-DD'. */
const dateFromYMD = (ymdStr) => {
    const [Y, M, D] = String(ymdStr).split('-').map((x) => parseInt(x, 10));
    return new Date(Y, (M || 1) - 1, D || 1); // evita el parseo UTC de 'YYYY-MM-DD'
};

/** Devuelve YYYY-MM-DD seguro en TZ negocio, a partir de Date o string. */
const asYMD = (val) => {
    // Si ya viene como 'YYYY-MM-DD', lo normalizamos (p. ej. '2025-10-09' → '2025-10-09')
    const s = String(val ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Si viene Date o string parseable, uso la misma TZ que todayYMD()
    const d = new Date(val);
    return toYMD_TZ(d);
};

/** Equivalentes semánticos previos, ahora TZ-consistentes */
const ymd = (dateOrStr) => asYMD(dateOrStr);
/** Date “fecha-solo” a partir de cualquier valor (primero lo paso a YMD TZ-consistente) */
const ymdDate = (dateOrStr) => dateFromYMD(asYMD(dateOrStr));

/** Hoy en TZ negocio, formateado */
const todayYMD = () => toYMD_TZ();

/* ===================== Helpers ===================== */
const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/** Normaliza tasa: admite 60 ó 0.60 → devuelve decimal 0.60 */
const normalizeRate = (r) => {
    const n = toNumber(r);
    if (n <= 0) return 0;
    return n > 1 ? n / 100 : n;
};

const getPeriodDays = (tipo) =>
    (tipo === 'semanal' ? 7 : tipo === 'quincenal' ? 15 : 30);

const esCreditoLibre = (credito) =>
    String(credito?.modalidad_credito ?? '') === 'libre';

/** ✅ Bloqueo duro: no permitir pagos si el crédito/cuota ya están refinanciados */
const assertNoPagoSiRefinanciado = ({ credito, cuota = null }) => {
    const creditoEstado = String(credito?.estado ?? '').toLowerCase();
    const cuotaEstado = String(cuota?.estado ?? '').toLowerCase();

    const creditoRefi = creditoEstado === 'refinanciado';
    // Por robustez: si en algún flujo marcan cuota como refinanciada/refinanciado
    const cuotaRefi = cuotaEstado === 'refinanciada' || cuotaEstado === 'refinanciado';

    if (creditoRefi || cuotaRefi) {
        const err = new Error(
            'No se puede registrar un pago: el crédito ya fue refinanciado (o la cuota pertenece a un crédito refinanciado).'
        );
        err.status = 409; // Conflict
        err.code = 'CREDITO_REFINANCIADO_NO_PAGO';
        throw err;
    }
};

/** Ciclo LIBRE actual (mensual, máx. 3): 1, 2 o 3 */
const cicloLibreActual = (credito, refDate = ymdDate(todayYMD())) => {
    const baseYMD = credito?.fecha_acreditacion || credito?.fecha_compromiso_pago || asYMD(refDate);
    const [Y, M, D] = String(baseYMD).split('-').map((x) => parseInt(x, 10));
    const inicio = new Date(Y, (M || 1) - 1, D || 1);
    const diff = Math.max(differenceInCalendarMonths(refDate, inicio), 0);
    return Math.min(LIBRE_MAX_CICLOS, diff + 1);
};

/** Devuelve cantidad de ciclos completos transcurridos entre dos fechas (YMD) según periodicidad. */
const ciclosTranscurridos = (desdeYMD, hastaYMD, tipo_credito) => {
    const days = differenceInCalendarDays(dateFromYMD(hastaYMD), dateFromYMD(desdeYMD));
    const period = getPeriodDays(tipo_credito);
    if (days <= 0) return 0;
    return Math.floor(days / period);
};

/** Inicio del ciclo vigente a partir de una fecha base (acreditación o compromiso) y una fecha de referencia */
const inicioCicloVigente = (fechaBaseYMD, tipo_credito, refYMD) => {
    const base = dateFromYMD(fechaBaseYMD);
    const ref = dateFromYMD(refYMD);
    const period = getPeriodDays(tipo_credito);
    const days = Math.max(differenceInCalendarDays(ref, base), 0);
    const completos = Math.floor(days / period);
    // usamos format solo para sumar días, luego convertimos a YMD TZ-consistente
    const sumado = addDays(base, completos * period);
    return asYMD(sumado);
};

/** Suma del interés de ciclo ya cobrado (stub por si en el futuro se trackea por recibos) */
const interesCicloCobradoEnRango = async ({ /* cuota_id, desdeYMD, hastaYMD, t = null */ }) => {
    return 0;
};

/** ✅ LIBRE: interés del ciclo actual = saldo_actual * tasaMensualDecimal */
const calcularInteresPendienteLibre = async ({ credito /*, cuota, hoyYMD, t*/ }) => {
    const tasa = normalizeRate(credito?.interes);
    const capital = fix2(credito?.saldo_actual || 0);
    if (tasa <= 0 || capital <= 0) return 0;
    return fix2(capital * tasa);
};

/** ✅ LIBRE: mora sobre el interés del mes si está vencido (desde fecha_compromiso_pago) */
const calcularMoraLibre = ({ credito, hoy = ymdDate(todayYMD()) }) => {
    const fcp = credito?.fecha_compromiso_pago;
    if (!fcp) return 0;

    // 🔒 No hay mora si hoy es el mismo día o antes del compromiso (comparación YMD con misma TZ)
    const hoyY = ymd(hoy);
    const fcpY = ymd(fcp);
    if (hoyY <= fcpY) return 0;

    // Días usando fechas truncadas (evita TZ/horas)
    const dias = differenceInCalendarDays(ymdDate(hoy), ymdDate(fcp));
    if (dias <= 0) return 0;

    const tasa = normalizeRate(credito?.interes);
    const capital = fix2(credito?.saldo_actual || 0);
    if (tasa <= 0 || capital <= 0) return 0;

    const interesMes = fix2(capital * tasa);
    const mora = fix2(interesMes * MORA_DIARIA_LIBRE * dias);
    return mora;
};

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
const simularMoraCuotaHasta = (cuota, pagos, hastaFecha = ymdDate(todayYMD())) => {
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

/* ───────── Helpers de presentación de RECIBO (UI) ───────── */
const formatARS = (n) =>
    Number(n || 0).toLocaleString('es-AR', {
        style: 'currency',
        currency: 'ARS',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

const formatYMDToDMY = (ymdStr) => {
    if (!ymdStr) return '';
    const [Y, M, D] = String(ymdStr).split('-');
    if (!Y || !M || !D) return String(ymdStr);
    return `${D.padStart(2, '0')}/${M.padStart(2, '0')}/${Y}`;
};

const nonAplicaIfZero = (value) => {
    const n = toNumber(value);
    return n === 0 ? 'No aplica' : formatARS(n);
};

// Detecta modalidad LIBRE con seguridad
const esReciboLibre = (recibo = {}) => {
    const mod = String(recibo.modalidad_credito || '').toLowerCase();
    if (mod === 'libre') return true;
    const concepto = String(recibo.concepto || '');
    return /LIBRE/i.test(concepto);
};

/** Construye un objeto "recibo_ui" listo para el frontend */
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

        // 🟦 NUEVO: mora pendiente reportable al front
        saldo_mora,

        // montos y saldos
        monto_pagado,
        pago_a_cuenta,
        saldo_anterior,
        saldo_actual,

        // capital del crédito
        saldo_credito_anterior,
        saldo_credito_actual
    } = recibo;

    const base = {
        numero_recibo: numero_recibo ?? null,
        fecha: formatYMDToDMY(fecha),
        hora: hora || '',
        cliente: cliente_nombre || '',
        cobrador: nombre_cobrador || '',
        medio_pago: medio_pago || '',
        concepto: concepto || '',
        modalidad_credito: modalidad_credito || undefined,

        // totales
        monto_pagado: formatARS(monto_pagado ?? pago_a_cuenta ?? 0),
        pago_a_cuenta: formatARS(pago_a_cuenta ?? monto_pagado ?? 0),

        // saldos totales (siempre $)
        saldo_anterior: formatARS(saldo_anterior),
        saldo_actual: formatARS(saldo_actual),

        // desglose
        importe_cuota_original:
            importe_cuota_original !== undefined ? formatARS(importe_cuota_original) : undefined,
        descuento_aplicado:
            descuento_aplicado !== undefined ? nonAplicaIfZero(descuento_aplicado) : undefined,
        mora_cobrada:
            mora_cobrada !== undefined ? nonAplicaIfZero(mora_cobrada) : undefined,

        // 🟦 NUEVO: campo “Saldo de mora”
        saldo_mora:
            saldo_mora !== undefined ? nonAplicaIfZero(saldo_mora) : undefined
    };

    if (!libre) {
        // NO-LIBRE → ocultamos capital/interés de ciclo y saldos de capital del crédito
        return base;
    }

    // LIBRE → agregamos estos campos si llegaron
    return {
        ...base,
        principal_pagado: principal_pagado !== undefined ? formatARS(principal_pagado) : undefined,
        interes_ciclo_cobrado:
            interes_ciclo_cobrado !== undefined ? nonAplicaIfZero(interes_ciclo_cobrado) : undefined,
        saldo_credito_anterior:
            saldo_credito_anterior !== undefined ? formatARS(saldo_credito_anterior) : undefined,
        saldo_credito_actual:
            saldo_credito_actual !== undefined ? formatARS(saldo_credito_actual) : undefined
    };
};

/* ───────── Caja: registrar ingreso desde un Recibo dentro de la misma TX ───────── */
const registrarIngresoDesdeReciboEnTx = async ({ t, recibo, forma_pago_id, usuario_id = null }) => {
    if (!recibo) return;
    const nowYMD = todayYMD();
    const nowTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date());
    await CajaMovimiento.create({
        fecha: recibo.fecha || nowYMD,
        hora: recibo.hora || nowTime,
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
        usuario_id: usuario_id ?? null
    }, { transaction: t });
};

/* ───────────────── Vencimientos ───────────────── */
export const actualizarCuotasVencidas = async () => {
    const hoy = todayYMD(); // YMD en TZ negocio

    // Excluir LIBRE
    const libres = await Credito.findAll({
        attributes: ['id'],
        where: { modalidad_credito: 'libre' },
        raw: true
    });
    const libreIds = libres.map(r => r.id);

    // Excluir refinanciados
    const refinanciados = await Credito.findAll({
        attributes: ['id'],
        where: { estado: 'refinanciado' },
        raw: true
    });
    const refiIds = refinanciados.map(r => r.id);

    // ⚠️ Solo vencidas si fv < HOY (mismo día NO se marca vencida)
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

    const credito = await Credito.findByPk(cuota.credito_id, { transaction: t });
    if (!credito) throw new Error('Crédito asociado no encontrado');

    // Usamos hoy tanto como Date truncado como YMD string
    const hoyStr = todayYMD();
    const hoyTZ = ymdDate(hoyStr);

    // ✅ LIBRE
    if (esCreditoLibre(credito) || cuota.fecha_vencimiento === VTO_FICTICIO_LIBRE) {
        const moraLibre = fix2(calcularMoraLibre({ credito, hoy: hoyTZ }));
        if (toNumber(cuota.intereses_vencidos_acumulados) !== moraLibre) {
            await cuota.update({ intereses_vencidos_acumulados: moraLibre }, { transaction: t });
        }
        return moraLibre;
    }

    if (String(credito.estado) === 'refinanciado') {
        if (cuota.intereses_vencidos_acumulados !== 0) {
            await cuota.update({ intereses_vencidos_acumulados: 0 }, { transaction: t });
        }
        return 0;
    }

    if (cuota.estado === 'pagada') {
        await cuota.update({ intereses_vencidos_acumulados: 0 }, { transaction: t });
        return 0;
    }

    // 💡 NO-LIBRE: además de la mora, ajustamos el estado a 'vencida' si fv < hoy
    let nuevoEstado = cuota.estado;
    if (
        cuota.fecha_vencimiento &&
        cuota.fecha_vencimiento !== VTO_FICTICIO_LIBRE &&
        (cuota.estado === 'pendiente' || cuota.estado === 'parcial')
    ) {
        const fvY = ymd(cuota.fecha_vencimiento);
        if (hoyStr > fvY) {
            nuevoEstado = 'vencida';
        }
    }

    const { moraPendiente } = simularMoraCuotaHasta(cuota, cuota.pagos, hoyTZ);

    const updates = { intereses_vencidos_acumulados: moraPendiente };
    if (nuevoEstado && nuevoEstado !== cuota.estado) {
        updates.estado = nuevoEstado;
    }

    await cuota.update(updates, { transaction: t });
    return moraPendiente;
};

export const recalcularMoraPorCredito = async (creditoId, t = null) => {
    const credito = await Credito.findByPk(creditoId, { transaction: t });
    if (!credito) throw new Error('Crédito no encontrado');

    const hoyStr = todayYMD();
    const hoyTZ = ymdDate(hoyStr);

    // ✅ LIBRE
    if (esCreditoLibre(credito)) {
        const cuotaLibre = await Cuota.findOne({
            where: { credito_id: creditoId },
            order: [['numero_cuota', 'ASC']],
            transaction: t
        });
        if (!cuotaLibre) return 0;
        const moraLibre = fix2(calcularMoraLibre({ credito, hoy: hoyTZ }));
        if (toNumber(cuotaLibre.intereses_vencidos_acumulados) !== moraLibre) {
            await cuotaLibre.update({ intereses_vencidos_acumulados: moraLibre }, { transaction: t });
        }
        return moraLibre;
    }

    if (String(credito.estado) === 'refinanciado') {
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
        // 🛡️ Si la cuota ya está pagada, garantizamos mora = 0 y NO tocamos el estado
        if (String(c.estado) === 'pagada') {
            if (toNumber(c.intereses_vencidos_acumulados) !== 0) {
                await c.update(
                    { intereses_vencidos_acumulados: 0 },
                    { transaction: t }
                );
            }
            continue;
        }

        const { moraPendiente } = simularMoraCuotaHasta(c, c.pagos, hoyTZ);

        // 💡 NO-LIBRE: sincronizamos también el estado vencida/pendiente/parcial
        let nuevoEstado = c.estado;
        if (
            c.fecha_vencimiento &&
            c.fecha_vencimiento !== VTO_FICTICIO_LIBRE &&
            c.estado !== 'pagada'
        ) {
            const fvY = ymd(c.fecha_vencimiento);
            if ((c.estado === 'pendiente' || c.estado === 'parcial') && hoyStr > fvY) {
                nuevoEstado = 'vencida';
            }
        }

        const updates = { intereses_vencidos_acumulados: moraPendiente };
        if (nuevoEstado && nuevoEstado !== c.estado) {
            updates.estado = nuevoEstado;
        }

        await c.update(updates, { transaction: t });
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
 * Listado de cuotas vencidas (NO libre/refi)
 */
export const obtenerCuotasVencidas = async (query = {}) => {
    await actualizarCuotasVencidas();

    const hoyY = todayYMD();
    const hoy = ymdDate(hoyY);

    const whereCuota = {
        estado: 'vencida',
        fecha_vencimiento: { [Op.lt]: hoyY, [Op.ne]: VTO_FICTICIO_LIBRE }
    };

    const desde = query.desde ? asYMD(query.desde) : null;
    const hasta = query.hasta ? asYMD(query.hasta) : null;
    if (desde && hasta) {
        whereCuota.fecha_vencimiento = { [Op.gte]: desde, [Op.lte]: hasta, [Op.ne]: VTO_FICTICIO_LIBRE };
    } else if (desde) {
        whereCuota.fecha_vencimiento = { [Op.gte]: desde, [Op.lt]: hoyY, [Op.ne]: VTO_FICTICIO_LIBRE };
    } else if (hasta) {
        whereCuota.fecha_vencimiento = { [Op.lte]: hasta, [Op.ne]: VTO_FICTICIO_LIBRE };
    }

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

    const clienteIds = [...new Set(creditos.map(cr => cr.cliente_id))];
    const clientes = await Cliente.findAll({
        where: { id: { [Op.in]: clienteIds } },
        attributes: ['id', 'nombre', 'apellido', 'zona']
    });
    const mapCliente = new Map(clientes.map(cl => [cl.id, cl]));

    const clienteId = query.clienteId ? Number(query.clienteId) : null;
    const cobradorId = query.cobradorId ? Number(query.cobradorId) : null;
    const zonaId = query.zonaId ?? null;
    const minDiasVencida = query.minDiasVencida ? Number(query.minDiasVencida) : null;

    const filas = [];
    for (const c of cuotas) {
        const cr = mapCredito.get(c.credito_id);
        if (!cr) continue;
        if (esCreditoLibre(cr) || String(cr.estado) === 'refinanciado') continue;

        const cl = mapCliente.get(cr.cliente_id);
        if (!cl) continue;

        if (clienteId && cl.id !== clienteId) continue;
        if (cobradorId && cr.cobrador_id !== cobradorId) continue;
        if (zonaId != null && String(cl.zona ?? '') !== String(zonaId)) continue;

        const diasVencida = differenceInCalendarDays(ymdDate(hoy), ymdDate(c.fecha_vencimiento));
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

    filas.sort((a, b) =>
        (a.fecha_vencimiento < b.fecha_vencimiento ? -1 :
            a.fecha_vencimiento > b.fecha_vencimiento ? 1 : 0));

    return filas;
};

/* ──────────────────────────────────────────────────────────────────────────
 * NUEVO: Ruta de cobro automática para el cobrador logueado
 *
 * Regla:
 *  - "vencidas": todas las cuotas NO-LIBRE en estado vencida (fv < hoy) + LIBRE por fecha_compromiso_pago < hoy
 *  - "hoy": cuotas NO-LIBRE en pendiente/parcial con fv == hoy + LIBRE por fecha_compromiso_pago == hoy
 *
 * Devuelve items listos para tabla.
 * Incluye zona_nombre si existe el modelo Zona (import dinámico robusto).
 * ────────────────────────────────────────────────────────────────────────── */
export const obtenerRutaCobroCobrador = async ({
    cobrador_id,
    hoy = todayYMD(),
    includeVencidas = true,
    includePendientesHoy = true,
    zonaId = null,
    clienteId = null,
    modo = 'plano' // 'plano' | 'separado'
} = {}) => {
    const cobradorIdNum = Number(cobrador_id);
    if (!Number.isFinite(cobradorIdNum) || cobradorIdNum <= 0) {
        throw new Error('cobrador_id inválido');
    }

    // Normalizamos hoy
    const hoyY = asYMD(hoy);
    const hoyDate = ymdDate(hoyY);

    // Asegura estados de vencidas al día
    await actualizarCuotasVencidas();

    /* ─────────────── Zona (opcional) ─────────────── */
    const mapZonaNombre = new Map(); // key: String(id) -> nombre
    const cargarZonasSiExiste = async (zonaIds = []) => {
        const idsNum = [
            ...new Set(
                (zonaIds ?? [])
                    .map((z) => Number(z))
                    .filter((n) => Number.isFinite(n))
            )
        ];
        if (idsNum.length === 0) return;

        let Zona = null;

        // 1) intento directo
        try {
            const mod = await import('../models/Zona.js');
            Zona = mod?.default ?? null;
        } catch {
            // ignore
        }

        // 2) fallback por index (si existe)
        if (!Zona) {
            try {
                const mod2 = await import('../models/index.js');
                Zona = mod2?.Zona ?? mod2?.default?.Zona ?? null;
            } catch {
                // ignore
            }
        }

        if (!Zona) return;

        const rows = await Zona.findAll({
            where: { id: { [Op.in]: idsNum } },
            attributes: ['id', 'nombre'],
            raw: true
        });

        for (const r of rows) {
            mapZonaNombre.set(String(r.id), r.nombre ?? String(r.id));
        }
    };

    /* ─────────────── NO-LIBRE: créditos del cobrador ─────────────── */
    const creditosNoLibre = await Credito.findAll({
        where: {
            cobrador_id: cobradorIdNum,
            modalidad_credito: { [Op.ne]: 'libre' },
            estado: { [Op.ne]: 'refinanciado' }
        },
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
    const creditoIdsNoLibre = creditosNoLibre.map((cr) => cr.id);
    const mapCreditoNoLibre = new Map(creditosNoLibre.map(cr => [cr.id, cr]));

    /* ─────────────── NO-LIBRE: cuotas (filtradas por esos créditos) ─────────────── */
    const orCuotas = [];
    if (includeVencidas) {
        orCuotas.push({
            estado: 'vencida',
            fecha_vencimiento: { [Op.lt]: hoyY, [Op.ne]: VTO_FICTICIO_LIBRE }
        });
    }
    if (includePendientesHoy) {
        orCuotas.push({
            estado: { [Op.in]: ['pendiente', 'parcial'] },
            fecha_vencimiento: hoyY
        });
    }

    let cuotas = [];
    if (creditoIdsNoLibre.length > 0 && orCuotas.length > 0) {
        cuotas = await Cuota.findAll({
            where: {
                credito_id: { [Op.in]: creditoIdsNoLibre },
                [Op.or]: orCuotas
            },
            attributes: [
                'id',
                'credito_id',
                'numero_cuota',
                'estado',
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
            order: [['fecha_vencimiento', 'ASC'], ['numero_cuota', 'ASC']]
        });
    }

    /* ─────────────── Clientes (NO-LIBRE) ─────────────── */
    const clienteIdsNoLibre = [...new Set(creditosNoLibre.map(cr => cr.cliente_id))];
    const clientesNoLibre = clienteIdsNoLibre.length
        ? await Cliente.findAll({
            where: { id: { [Op.in]: clienteIdsNoLibre } },
            attributes: [
                'id',
                'nombre',
                'apellido',
                'dni',
                'telefono',
                'telefono_secundario',
                'direccion',
                'zona'
            ]
        })
        : [];
    const mapCliente = new Map(clientesNoLibre.map(cl => [cl.id, cl]));

    await cargarZonasSiExiste(clientesNoLibre.map(c => c.zona).filter(Boolean));

    /* ─────────────── LIBRE: créditos por fecha_compromiso_pago ─────────────── */
    const orLibre = [];
    if (includeVencidas) {
        orLibre.push({ fecha_compromiso_pago: { [Op.lt]: hoyY } });
    }
    if (includePendientesHoy) {
        orLibre.push({ fecha_compromiso_pago: hoyY });
    }

    const creditosLibres = orLibre.length
        ? await Credito.findAll({
            where: {
                cobrador_id: cobradorIdNum,
                modalidad_credito: 'libre',
                estado: { [Op.notIn]: ['refinanciado', 'pagado', 'anulado'] },
                saldo_actual: { [Op.gt]: 0 },
                fecha_compromiso_pago: { [Op.ne]: null },
                [Op.or]: orLibre
            },
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
        })
        : [];

    const libreIds = creditosLibres.map(cr => cr.id);

    // Mapear cuota_id “operable” para LIBRE (normalmente la primera/única)
    const cuotasLibresAll = libreIds.length
        ? await Cuota.findAll({
            where: { credito_id: { [Op.in]: libreIds } },
            attributes: ['id', 'credito_id', 'numero_cuota'],
            order: [['credito_id', 'ASC'], ['numero_cuota', 'ASC']]
        })
        : [];
    const mapCuotaLibre = new Map();
    for (const c of cuotasLibresAll) {
        if (!mapCuotaLibre.has(c.credito_id)) mapCuotaLibre.set(c.credito_id, c);
    }

    const clienteIdsLibre = [...new Set(creditosLibres.map(cr => cr.cliente_id))];
    const clientesLibre = clienteIdsLibre.length
        ? await Cliente.findAll({
            where: { id: { [Op.in]: clienteIdsLibre } },
            attributes: [
                'id',
                'nombre',
                'apellido',
                'dni',
                'telefono',
                'telefono_secundario',
                'direccion',
                'zona'
            ]
        })
        : [];
    for (const cl of clientesLibre) {
        if (!mapCliente.has(cl.id)) mapCliente.set(cl.id, cl);
    }

    await cargarZonasSiExiste(clientesLibre.map(c => c.zona).filter(Boolean));

    /* ─────────────── Construcción de filas ─────────────── */
    const items = [];

    // NO-LIBRE filas
    for (const c of cuotas) {
        const cr = mapCreditoNoLibre.get(c.credito_id);
        if (!cr) continue; // seguridad

        const cl = mapCliente.get(cr.cliente_id);
        if (!cl) continue;

        if (clienteId != null && Number(clienteId) && cl.id !== Number(clienteId)) continue;
        if (zonaId != null && String(cl.zona ?? '') !== String(zonaId)) continue;

        const fv = asYMD(c.fecha_vencimiento);
        const categoria =
            (String(c.estado) === 'vencida' && fv < hoyY)
                ? 'vencida'
                : (fv === hoyY ? 'hoy' : null);

        if (!categoria) continue;

        const diasVencida =
            categoria === 'vencida'
                ? Math.max(differenceInCalendarDays(hoyDate, ymdDate(fv)), 0)
                : 0;

        const sim = simularMoraCuotaHasta(c, c.pagos, hoyDate);
        const mora_pendiente = fix2(sim.moraPendiente);
        const saldo_principal_pendiente = fix2(sim.saldoPrincipalPendiente);
        const total_a_pagar_hoy = fix2(mora_pendiente + saldo_principal_pendiente);

        const zona_id = cl.zona ?? null;
        const zona_nombre = zona_id != null
            ? (mapZonaNombre.get(String(zona_id)) ?? String(zona_id))
            : null;

        items.push({
            categoria, // 'vencida' | 'hoy'
            modalidad_credito: cr.modalidad_credito,
            tipo_credito: cr.tipo_credito,
            credito_estado: cr.estado,

            cuota_id: c.id,
            credito_id: c.credito_id,
            numero_cuota: c.numero_cuota,
            estado_cuota: c.estado,
            fecha_vencimiento: fv,
            dias_vencida: diasVencida,

            // Cliente
            cliente_id: cl.id,
            cliente_nombre: cl.nombre,
            cliente_apellido: cl.apellido,
            cliente_dni: cl.dni ?? null,
            cliente_telefono: cl.telefono ?? null,
            cliente_telefono_secundario: cl.telefono_secundario ?? null,
            cliente_direccion: cl.direccion ?? null,
            zona_id,
            zona_nombre,

            // Montos NO-LIBRE (operables por cuota)
            importe_cuota: fix2(c.importe_cuota),
            descuento_cuota: fix2(c.descuento_cuota),
            monto_pagado_acumulado: fix2(c.monto_pagado_acumulado),

            mora_pendiente,
            saldo_principal_pendiente,
            total_a_pagar_hoy
        });
    }

    // LIBRE filas
    let libres_sin_cuota = 0;
    for (const cr of creditosLibres) {
        const cl = mapCliente.get(cr.cliente_id);
        if (!cl) continue;

        if (clienteId != null && Number(clienteId) && cl.id !== Number(clienteId)) continue;
        if (zonaId != null && String(cl.zona ?? '') !== String(zonaId)) continue;

        const fcp = asYMD(cr.fecha_compromiso_pago);
        const categoria =
            (includeVencidas && fcp < hoyY) ? 'vencida'
                : (includePendientesHoy && fcp === hoyY) ? 'hoy'
                    : null;

        if (!categoria) continue;

        const diasVencida =
            categoria === 'vencida'
                ? Math.max(differenceInCalendarDays(hoyDate, ymdDate(fcp)), 0)
                : 0;

        const cuotaOperable = mapCuotaLibre.get(cr.id) || null;
        if (!cuotaOperable?.id) {
            libres_sin_cuota += 1;
            continue; // sin cuota_id no se puede operar el cobro
        }

        const saldo_capital = fix2(cr.saldo_actual || 0);
        const interes_pendiente_hoy = fix2(await calcularInteresPendienteLibre({ credito: cr }));
        const mora_pendiente_hoy = fix2(calcularMoraLibre({ credito: cr, hoy: hoyDate }));
        const total_a_pagar_hoy = fix2(saldo_capital + interes_pendiente_hoy + mora_pendiente_hoy);

        const zona_id = cl.zona ?? null;
        const zona_nombre = zona_id != null
            ? (mapZonaNombre.get(String(zona_id)) ?? String(zona_id))
            : null;

        items.push({
            categoria,
            modalidad_credito: 'libre',
            tipo_credito: cr.tipo_credito,
            credito_estado: cr.estado,

            // Para operar pagos LIBRE necesitamos cuota_id
            cuota_id: cuotaOperable.id,
            credito_id: cr.id,
            numero_cuota: cuotaOperable.numero_cuota ?? null,

            // En LIBRE usamos fecha_compromiso_pago como “vencimiento operativo”
            fecha_vencimiento: fcp,
            dias_vencida: diasVencida,

            // Cliente
            cliente_id: cl.id,
            cliente_nombre: cl.nombre,
            cliente_apellido: cl.apellido,
            cliente_dni: cl.dni ?? null,
            cliente_telefono: cl.telefono ?? null,
            cliente_telefono_secundario: cl.telefono_secundario ?? null,
            cliente_direccion: cl.direccion ?? null,
            zona_id,
            zona_nombre,

            // Montos LIBRE (liquidación)
            saldo_capital,
            interes_pendiente_hoy,
            mora_pendiente_hoy,
            total_a_pagar_hoy
        });
    }

    // Orden sugerido: vencidas primero, luego hoy; y dentro por fecha y cliente
    items.sort((a, b) => {
        const prA = a.categoria === 'vencida' ? 0 : 1;
        const prB = b.categoria === 'vencida' ? 0 : 1;
        if (prA !== prB) return prA - prB;

        if (a.fecha_vencimiento !== b.fecha_vencimiento) {
            return a.fecha_vencimiento < b.fecha_vencimiento ? -1 : 1;
        }

        const an = `${a.cliente_apellido ?? ''} ${a.cliente_nombre ?? ''}`.trim().toLowerCase();
        const bn = `${b.cliente_apellido ?? ''} ${b.cliente_nombre ?? ''}`.trim().toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;

        return (a.credito_id ?? 0) - (b.credito_id ?? 0);
    });

    const meta = {
        cobrador_id: cobradorIdNum,
        hoy: hoyY,
        total: items.length,
        total_vencidas: items.filter(i => i.categoria === 'vencida').length,
        total_hoy: items.filter(i => i.categoria === 'hoy').length,
        libres_sin_cuota
    };

    if (modo === 'separado') {
        return {
            vencidas: items.filter(i => i.categoria === 'vencida'),
            hoy: items.filter(i => i.categoria === 'hoy'),
            meta
        };
    }

    return { items, meta };
};

/* ───────────────── Recibos ───────────────── */
/** Devuelve el nombre legible de la modalidad de crédito para usar en el concepto del recibo */
const nombreModalidadCredito = (modalidadRaw) => {
    const mod = String(modalidadRaw || '').toLowerCase();
    if (mod === 'libre') return 'LIBRE';
    if (mod === 'comun') return 'PLAN DE CUOTAS FIJAS';
    if (mod === 'progresivo') return 'PROGRESIVO';
    return 'CRÉDITO';
};

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
    // saldoCuotaAnterior / saldoCuotaActual ahora representan el **TOTAL** (principal+interés/mora)
    saldoCuotaAnterior = undefined,
    saldoCuotaActual = undefined,
    // 🟦 NUEVO: reportar mora pendiente (saldo de mora) al momento del recibo
    saldoMoraRestante = undefined
}) => {
    const nowYMD = todayYMD();
    const nowTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', hour12: false, second: '2-digit'
    }).format(new Date());

    return {
        cliente_id: cliente.id,
        pago_id: pago.id,
        cuota_id: cuota.id,
        cliente_nombre: `${cliente.nombre} ${cliente.apellido}`,
        monto_pagado: fix2(pago.monto_pagado),
        concepto: conceptoExtra || `Pago cuota #${cuota.numero_cuota} del ${nombreModalidadCredito(credito?.modalidad_credito)} #${credito.id}`,
        fecha: nowYMD,
        hora: nowTime,

        // 🔵 AHORA SIEMPRE TOTALES (principal + interés/mora)
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

        // 🟦 NUEVO: guardamos también el saldo de mora pendiente
        saldo_mora: saldoMoraRestante !== undefined ? fix2(saldoMoraRestante) : undefined,

        // Saldos del crédito (capital)
        saldo_credito_anterior: fix2(saldoCreditoAntes),
        saldo_credito_actual: fix2(saldoCreditoDespues),

        // Interés de ciclo (LIBRE)
        interes_ciclo_cobrado: fix2(interesCicloCobrado),

        // Extra para el UI builder
        modalidad_credito: credito?.modalidad_credito || undefined
    };
};

/* ───────────────── Pagos ───────────────── */
export const pagarCuota = async (...args) => {
    if (args.length && typeof args[0] !== 'object') {
        const [cuotaId, formaPagoId, observacion = null, usuario_id = null] = args;
        return pagarCuotaTotal({
            cuota_id: cuotaId,
            forma_pago_id: formaPagoId,
            descuento: 0,
            observacion,
            usuario_id
        });
    }
    return pagarCuotaTotal(args[0]);
};

const pagarCuotaTotal = async ({
    cuota_id,
    forma_pago_id,
    descuento = 0,
    descuento_scope = null,   // 'mora' | 'total' | null
    descuento_mora = null,    // para 'mora' (en LIBRE se interpreta como %; en NO-LIBRE como MONTO)
    observacion = null,
    usuario_id = null,
    rol_id = null
}) => {
    const t = await sequelize.transaction();
    try {
        const cuota = await Cuota.findByPk(cuota_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (!cuota) throw new Error('Cuota no encontrada');

        // 🔒 Bloqueo del crédito también
        const credito = await Credito.findByPk(cuota.credito_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!credito) throw new Error('Crédito asociado no encontrado');

        // ✅ BLOQUEO: si está refinanciado, NO se paga
        assertNoPagoSiRefinanciado({ credito, cuota });

        const cliente = await Cliente.findByPk(credito.cliente_id, { transaction: t });
        const cobrador = await Usuario.findByPk(credito.cobrador_id, { transaction: t });
        const medioPago = await FormaPago.findByPk(forma_pago_id, { transaction: t });

        const isAdmin = Number(rol_id) === 1;

        // —— LIBRE → Total = CAPITAL + INTERÉS + MORA (descuento solo sobre MORA) —— 
        if (esCreditoLibre(credito)) {
            const hoyYMD_TZ = todayYMD();

            const saldoCapital = fix2(credito.saldo_actual);
            const interesPendiente = await calcularInteresPendienteLibre({ credito });
            const moraLibre = fix2(calcularMoraLibre({ credito, hoy: ymdDate(hoyYMD_TZ) }));

            // ✅ Regla: descuento permitido SOLO sobre mora
            // - En LIBRE lo interpretamos como % (0..100)
            //   * Si viene descuento_scope='mora' y descuento_mora: usamos descuento_mora (%)
            //   * Si no, usamos descuento (% legacy)
            const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
            const pctRaw = scope === 'mora'
                ? (descuento_mora != null ? toNumber(descuento_mora) : toNumber(descuento))
                : toNumber(descuento);

            const pct = clamp(fix2(pctRaw), 0, 100);
            const descuentoMora = fix2(moraLibre * (pct / 100));
            const moraNeta = fix2(Math.max(moraLibre - descuentoMora, 0));

            const totalAPagar = fix2(saldoCapital + interesPendiente + moraNeta);

            const pago = await Pago.create(
                { cuota_id, monto_pagado: totalAPagar, forma_pago_id, observacion, fecha_pago: hoyYMD_TZ },
                { transaction: t }
            );

            // Cerrar cuota y crédito
            await cuota.update({
                estado: 'pagada',
                forma_pago_id,
                descuento_cuota: fix2(toNumber(cuota.descuento_cuota)),
                monto_pagado_acumulado: fix2(cuota.importe_cuota), // cerramos capital
                intereses_vencidos_acumulados: 0
            }, { transaction: t });

            const saldoAntes = fix2(credito.saldo_actual);
            await credito.update({
                saldo_actual: 0,
                estado: 'pagado',
                // acumulamos interés + mora neta cobrada (no incluye descuento “perdonado”)
                interes_acumulado: fix2(toNumber(credito.interes_acumulado) + interesPendiente + moraNeta)
            }, { transaction: t });

            // 🔵 TOTALES del ciclo ANTES/DESPUÉS
            const totalAntes = fix2(saldoCapital + interesPendiente + moraLibre);
            const totalDespues = 0;

            const recibo = await Recibo.create(armarDatosRecibo({
                cliente,
                cobrador,
                pago,
                cuota,
                credito,
                medioPagoNombre: medioPago?.nombre ?? 'N/D',
                importeOriginalCuota: cuota.importe_cuota,
                descuentoAplicado: descuentoMora,    // descuento aplicado a MORA
                moraCobrada: moraNeta,
                principalPagado: saldoCapital,
                saldoPrincipalAntes: saldoAntes,      // (fallback)
                saldoPrincipalDespues: 0,             // (fallback)
                saldoCreditoAntes: saldoAntes,
                saldoCreditoDespues: 0,
                conceptoExtra: `Liquidación LIBRE #${credito.id}`,
                interesCicloCobrado: interesPendiente,
                saldoCuotaAnterior: totalAntes,       // ✅ total (cap + int + mora)
                saldoCuotaActual: totalDespues,       // ✅ total
                // 🟦 NUEVO: pago total → saldo de mora restante = 0
                saldoMoraRestante: 0
            }), { transaction: t });

            // ⬇️ Adjuntar UI sin persistir
            const plain = recibo.get({ plain: true });
            plain.modalidad_credito = credito.modalidad_credito; // ayuda al front
            const ui = buildReciboUI(plain);
            recibo.setDataValue('recibo_ui', ui);
            recibo.setDataValue('modalidad_credito', credito.modalidad_credito);

            // ⬇️ CAJA (ingreso por recibo)
            await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });

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

        // ✅ Regla: descuento permitido SOLO sobre la mora
        // - En NO-LIBRE lo interpretamos como MONTO
        //   * Si viene descuento_scope='mora' y descuento_mora: usamos descuento_mora (MONTO)
        //   * Si no, usamos descuento (legacy, MONTO)
        const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
        const descuentoMoraBruto = scope === 'mora'
            ? (descuento_mora != null ? fix2(toNumber(descuento_mora)) : fix2(toNumber(descuento)))
            : fix2(toNumber(descuento));

        const descuentoMora = Math.min(Math.max(descuentoMoraBruto, 0), fix2(moraActual));
        const moraNeta = fix2(Math.max(moraActual - descuentoMora, 0));

        // El principal NO recibe nuevo descuento acá
        const saldoPrincipalTrasDescuento = Math.max(importeOriginal - descuentoPrevio - principalPagadoPrevio, 0);

        const netoAPagar = fix2(moraNeta + saldoPrincipalTrasDescuento);

        const pago = await Pago.create(
            { cuota_id, monto_pagado: netoAPagar, forma_pago_id, observacion, fecha_pago: todayYMD() },
            { transaction: t }
        );

        // Primero cubrimos mora neta y luego principal
        const moraCobrada = Math.min(netoAPagar, moraNeta);
        const principalPagado = Math.max(netoAPagar - moraCobrada, 0);

        // 🔧 Ajustes de cuota/credito
        cuota.intereses_vencidos_acumulados = fix2(Math.max(moraNeta - moraCobrada, 0));
        cuota.monto_pagado_acumulado = fix2(principalPagadoPrevio + principalPagado);
        // No se incrementa descuento_cuota con este descuento (solo aplica a MORA)
        cuota.descuento_cuota = descuentoPrevio;
        cuota.estado = 'pagada';
        cuota.forma_pago_id = forma_pago_id;
        await cuota.save({ transaction: t });

        credito.interes_acumulado = fix2(toNumber(credito.interes_acumulado) + moraCobrada);
        credito.saldo_actual = fix2(Math.max(toNumber(credito.saldo_actual) - principalPagado, 0));
        await credito.save({ transaction: t });

        // 🔵 TOTALES de cuota ANTES/DESPUÉS (mostramos total antes con moraActual)
        const totalAntes = fix2(saldoPrincipalTrasDescuento + moraActual);
        const totalDespues = 0;

        const recibo = await Recibo.create(armarDatosRecibo({
            cliente,
            cobrador,
            pago,
            cuota,
            credito,
            medioPagoNombre: medioPago?.nombre ?? 'N/D',
            importeOriginalCuota: importeOriginal,
            descuentoAplicado: descuentoMora,   // 🔵 bonificación sobre MORA
            moraCobrada,
            principalPagado,
            saldoPrincipalAntes: Math.max(importeOriginal - descuentoPrevio - principalPagadoPrevio, 0), // (fallback)
            saldoPrincipalDespues: 0,           // (fallback)
            saldoCreditoAntes: fix2(toNumber(credito.saldo_actual) + principalPagado),
            saldoCreditoDespues: toNumber(credito.saldo_actual),
            interesCicloCobrado: 0,
            saldoCuotaAnterior: totalAntes,     // ✅ total (principal + mora ANTES del descuento)
            saldoCuotaActual: totalDespues,     // ✅ total
            // 🟦 Pago total → saldo de mora restante = 0
            saldoMoraRestante: 0
        }), { transaction: t });

        // ⬇️ Adjuntar UI sin persistir (NO-LIBRE)
        const plain = recibo.get({ plain: true });
        plain.modalidad_credito = credito.modalidad_credito;
        const ui = buildReciboUI(plain);
        recibo.setDataValue('recibo_ui', ui);
        recibo.setDataValue('modalidad_credito', credito.modalidad_credito);

        await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });

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
    descuento = 0,
    descuento_scope = null,   // 'mora' | null
    descuento_mora = null,    // en LIBRE se interpreta como %; en NO-LIBRE como MONTO
    usuario_id = null,
    rol_id = null
}) => {
    const t = await sequelize.transaction();
    try {
        if (toNumber(monto_pagado) <= 0) throw new Error('monto_pagado debe ser > 0');

        const cuota = await Cuota.findByPk(cuota_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (!cuota) throw new Error('Cuota no encontrada');

        // 🔒 Bloqueo del crédito también
        const credito = await Credito.findByPk(cuota.credito_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!credito) throw new Error('Crédito asociado no encontrado');

        // ✅ BLOQUEO: si está refinanciado, NO se paga
        assertNoPagoSiRefinanciado({ credito, cuota });

        const cliente = await Cliente.findByPk(credito.cliente_id, { transaction: t });
        const cobrador = await Usuario.findByPk(credito.cobrador_id, { transaction: t });
        const medioPago = await FormaPago.findByPk(forma_pago_id, { transaction: t });

        const hoyYMD_TZ = todayYMD();
        const isAdmin = Number(rol_id) === 1;

        // —— LIBRE → parcial: INTERÉS → MORA → CAPITAL —— 
        if (esCreditoLibre(credito)) {
            const ciclo = cicloLibreActual(credito, ymdDate(hoyYMD_TZ));
            if (ciclo >= LIBRE_MAX_CICLOS) {
                throw new Error('En el 3er mes del crédito LIBRE no se permite pago parcial. Debe registrar pago total (cancelación del crédito).');
            }

            const pagado = fix2(monto_pagado);
            const saldoAntes = fix2(credito.saldo_actual);

            const interesPendiente = await calcularInteresPendienteLibre({ credito });
            const moraLibre = fix2(calcularMoraLibre({ credito, hoy: ymdDate(hoyYMD_TZ) }));

            // ✅ Descuento (solo sobre mora) en LIBRE = % (0..100)
            const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
            const pctRaw = scope === 'mora'
                ? (descuento_mora != null ? toNumber(descuento_mora) : toNumber(descuento))
                : toNumber(descuento);

            const pct = clamp(fix2(pctRaw), 0, 100);
            const descuentoMora = fix2(moraLibre * (pct / 100));
            const moraNeta = fix2(Math.max(moraLibre - descuentoMora, 0));

            const aInteres = Math.min(pagado, interesPendiente);
            const restoTrasInteres = fix2(pagado - aInteres);
            const aMora = Math.min(restoTrasInteres, moraNeta);
            const aCapital = Math.min(Math.max(restoTrasInteres - aMora, 0), saldoAntes);

            const nuevoSaldo = fix2(Math.max(saldoAntes - aCapital, 0));
            const moraRestante = fix2(Math.max(moraNeta - aMora, 0));
            const interesRestante = fix2(Math.max(interesPendiente - aInteres, 0));

            const pago = await Pago.create(
                { cuota_id, monto_pagado: pagado, forma_pago_id, observacion, fecha_pago: hoyYMD_TZ },
                { transaction: t }
            );

            const nuevaEstado = nuevoSaldo > 0 ? 'parcial' : 'pagada';
            await cuota.update({
                estado: nuevaEstado,
                forma_pago_id,
                intereses_vencidos_acumulados: moraRestante
                // monto_pagado_acumulado: lo cerramos solo en pago total
            }, { transaction: t });

            await credito.update({
                saldo_actual: nuevoSaldo,
                interes_acumulado: fix2(toNumber(credito.interes_acumulado) + aInteres + aMora),
                estado: nuevoSaldo === 0 ? 'pagado' : credito.estado
            }, { transaction: t });

            // 🔵 TOTALES del ciclo ANTES/DESPUÉS
            // "Antes": con mora bruta (descuento visible como campo aparte)
            // "Después": con mora neta restante
            const totalAntes = fix2(saldoAntes + interesPendiente + moraLibre);
            const totalDespues = fix2(nuevoSaldo + interesRestante + moraRestante);

            const recibo = await Recibo.create(armarDatosRecibo({
                cliente,
                cobrador,
                pago,
                cuota,
                credito,
                medioPagoNombre: medioPago?.nombre ?? 'N/D',
                importeOriginalCuota: cuota.importe_cuota,
                descuentoAplicado: descuentoMora,
                moraCobrada: aMora,
                principalPagado: aCapital,
                saldoPrincipalAntes: saldoAntes,          // (fallback)
                saldoPrincipalDespues: nuevoSaldo,        // (fallback)
                saldoCreditoAntes: saldoAntes,
                saldoCreditoDespues: nuevoSaldo,
                conceptoExtra: `Pago parcial LIBRE #${credito.id}`,
                interesCicloCobrado: aInteres,
                saldoCuotaAnterior: totalAntes,           // ✅ total (cap + int + mora bruta)
                saldoCuotaActual: totalDespues,           // ✅ total (cap + int + mora neta restante)
                // 🟦 NUEVO: saldo de mora restante informado
                saldoMoraRestante: moraRestante
            }), { transaction: t });

            // ⬇️ Adjuntar UI sin persistir
            const plain = recibo.get({ plain: true });
            plain.modalidad_credito = credito.modalidad_credito;
            const ui = buildReciboUI(plain);
            recibo.setDataValue('recibo_ui', ui);
            recibo.setDataValue('modalidad_credito', credito.modalidad_credito);

            await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });

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

        // ✅ Descuento permitido SOLO sobre mora
        // - NO-LIBRE: MONTO
        const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
        const descMoraRaw = scope === 'mora'
            ? (descuento_mora != null ? fix2(toNumber(descuento_mora)) : fix2(toNumber(descuento)))
            : fix2(toNumber(descuento));

        const descuentoMora = Math.min(Math.max(descMoraRaw, 0), fix2(moraActual));
        const moraNeta = fix2(Math.max(moraActual - descuentoMora, 0));

        // No alteramos descuentos sobre principal aquí
        const saldoPrincipalTrasDescuento = Math.max(importeCuota - descuentoPrevio - principalPagadoPrevio, 0);

        const pago = await Pago.create(
            { cuota_id, monto_pagado: fix2(monto_pagado), forma_pago_id, observacion, fecha_pago: hoyYMD_TZ },
            { transaction: t }
        );

        // Asignación: primero MORA (neto), luego PRINCIPAL
        const aMora = Math.min(fix2(monto_pagado), moraNeta);
        const aPrincipal = Math.max(fix2(monto_pagado) - aMora, 0);
        const principalEfectivo = Math.min(aPrincipal, saldoPrincipalTrasDescuento);

        cuota.intereses_vencidos_acumulados = fix2(Math.max(moraNeta - aMora, 0));
        cuota.monto_pagado_acumulado = fix2(principalPagadoPrevio + principalEfectivo);
        // Mantener descuento_cuota sin cambios (NO se usa para bonificar mora)
        cuota.descuento_cuota = descuentoPrevio;

        const principalPendienteDespues = Math.max(
            importeCuota - cuota.descuento_cuota - cuota.monto_pagado_acumulado,
            0
        );
        const moraRestante = fix2(cuota.intereses_vencidos_acumulados);

        if (principalPendienteDespues <= 0 && moraRestante <= 0) {
            cuota.estado = 'pagada';
        } else if (['pendiente', 'parcial', 'vencida'].includes(cuota.estado)) {
            cuota.estado = principalEfectivo > 0 ? 'parcial' : cuota.estado;
        }

        // Reprogramación si cubrió interés original
        const tasa = normalizeRate(credito.interes);
        const principalOriginal = importeCuota / (1 + tasa);
        const interesPorCuota = importeCuota - principalOriginal;

        if (principalEfectivo >= interesPorCuota) {
            const base = dateFromYMD(cuota.fecha_vencimiento);
            const delta =
                credito.tipo_credito === 'semanal' ? 7 :
                    credito.tipo_credito === 'quincenal' ? 15 : 30;
            const nuevoVto = addDays(base, delta);
            cuota.fecha_vencimiento = asYMD(nuevoVto);
            if (cuota.estado === 'vencida') cuota.estado = 'pendiente';
        }

        await cuota.save({ transaction: t });

        credito.interes_acumulado = fix2(toNumber(credito.interes_acumulado) + aMora);
        credito.saldo_actual = fix2(Math.max(toNumber(credito.saldo_actual) - principalEfectivo, 0));
        await credito.save({ transaction: t });

        // 🔵 TOTALES de cuota ANTES/DESPUÉS (antes con moraActual “bruta”)
        const totalAntes = fix2(saldoPrincipalTrasDescuento + moraActual);
        const totalDespues = fix2(principalPendienteDespues + moraRestante);

        const recibo = await Recibo.create(armarDatosRecibo({
            cliente,
            cobrador,
            pago,
            cuota,
            credito,
            medioPagoNombre: medioPago?.nombre ?? 'N/D',
            importeOriginalCuota: importeCuota,
            descuentoAplicado: descuentoMora,           // 🔵 bonificación sobre MORA
            moraCobrada: aMora,
            principalPagado: principalEfectivo,
            saldoPrincipalAntes,                         // (fallback)
            saldoPrincipalDespues: fix2(principalPendienteDespues),  // (fallback)
            saldoCreditoAntes,
            saldoCreditoDespues: toNumber(credito.saldo_actual),
            interesCicloCobrado: 0,
            saldoCuotaAnterior: totalAntes,              // ✅ total (principal + mora antes del desc.)
            saldoCuotaActual: totalDespues,              // ✅ total
            // 🟦 NUEVO: saldo de mora restante informado
            saldoMoraRestante: moraRestante
        }), { transaction: t });

        // ⬇️ Adjuntar UI sin persistir (NO-LIBRE)
        const plain = recibo.get({ plain: true });
        plain.modalidad_credito = credito.modalidad_credito;
        const ui = buildReciboUI(plain);
        recibo.setDataValue('recibo_ui', ui);
        recibo.setDataValue('modalidad_credito', credito.modalidad_credito);

        await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });

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

        // Si hay pagos asociados, no permitimos borrar
        const tienePagos = await Pago.count({ where: { cuota_id: id }, transaction: t });
        if (tienePagos > 0) {
            await t.rollback();
            const err = new Error('No se puede eliminar la cuota: tiene pagos registrados.');
            err.status = 409;
            throw err;
        }

        // Limpieza: recibos sueltos (y movimientos de caja)
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
            try { await t.rollback(); } catch (_) { }
        }
        throw e;
    }
};

/* ───────────────── Resumen LIBRE ───────────────── */
export const obtenerResumenLibrePorCredito = async (creditoId, fecha = ymdDate(todayYMD())) => {
    const credito = await Credito.findByPk(creditoId);
    if (!credito) throw new Error('Crédito no encontrado');

    const saldo = fix2(credito.saldo_actual);
    const tasaDec = normalizeRate(credito.interes);

    // Si NO es libre, solo capital
    if (!esCreditoLibre(credito)) {
        return {
            credito_id: credito.id,
            saldo_capital: saldo,
            interes_pendiente_hoy: 0,
            mora_pendiente_hoy: 0,
            total_liquidacion_hoy: saldo,
            tasa_decimal: tasaDec,
            hoy: asYMD(fecha)
        };
    }

    const cuota = await Cuota.findOne({ where: { credito_id: creditoId }, order: [['numero_cuota', 'ASC']] });
    if (!cuota) throw new Error('No se encontró cuota abierta del crédito libre');

    const hoyYMD = asYMD(fecha);
    const interesPendiente = await calcularInteresPendienteLibre({ credito, cuota, hoyYMD });
    const moraLibre = fix2(calcularMoraLibre({ credito, hoy: fecha }));

    return {
        credito_id: credito.id,
        saldo_capital: saldo,
        interes_pendiente_hoy: fix2(interesPendiente),
        mora_pendiente_hoy: fix2(moraLibre),
        total_liquidacion_hoy: fix2(saldo + interesPendiente + moraLibre),
        tasa_decimal: tasaDec,
        hoy: hoyYMD,
        ciclo_actual: cicloLibreActual(credito, fecha)
    };
};