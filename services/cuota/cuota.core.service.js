// financiera-backend/services/cuota/cuota.core.service.js
// Núcleo de cuotas (NO-LIBRE + orquestación). La lógica LIBRE está en cuota.libre.service.js

import Cuota from '../../models/Cuota.js';
import FormaPago from '../../models/FormaPago.js';
import Pago from '../../models/Pago.js';
import Credito from '../../models/Credito.js';
import Cliente from '../../models/Cliente.js';
import Usuario from '../../models/Usuario.js';
import Recibo from '../../models/Recibo.js';
import {
    MORA_DIARIA,
    APP_TZ,
    toYMD_TZ,
    dateFromYMD,
    asYMD,
    ymd,
    ymdDate,
    todayYMD,
    toNumber,
    fix2,
    clamp,
    normalizeRate,
    getPeriodDays,
    isMissingColumnError,
    reciboTieneCicloLibreCol,
    normalizarAttributesRecibo,
    findAllReciboSafe,
    findOneReciboSafe,
    marcarReciboSinCicloLibre
} from './cuota.utils.js';

import {
    MORA_DIARIA_LIBRE,
    VTO_FICTICIO_LIBRE,
    LIBRE_MAX_CICLOS,
    whereRecibosLibrePorCiclo,
    esCreditoLibre,
    cicloLibreActual,
    rangoCicloLibre,
    vencimientoCicloLibre,
    obtenerCuotaIdsPorCredito,
    obtenerCuotaBaseLibre,
    sumRecibosCampoPorCiclo,
    fechaCierreInteresCicloLibre,
    capitalBaseLibreParaCiclo,
    interesBrutoLibreParaCiclo,
    deudaLibrePorCiclo,
    deudaLibreTotalHoy,
    cicloLibreMasViejoAbierto,
    calcularInteresPendienteLibre,
    calcularMoraPendienteLibreExacto,
    assertNoPagoSiRefinanciado,
    pagarCuotaLibreEnTx,
    registrarPagoParcialLibreEnTx,

    // ✅ NUEVO: lo usamos para mantener coherencia con el “resumen exacto”
    // (mora/interest HOY = ciclo actual)
    obtenerResumenLibrePorCredito
} from './cuota.libre.service.js';

import { simularMoraCuotaHasta } from './cuota.mora.service.js';
import { buildReciboUI, armarDatosRecibo, createReciboSafe } from './cuota.recibo.service.js';
import { registrarIngresoDesdeReciboEnTx } from './cuota.caja.service.js';
import { crearReciboEnTxCompat } from './cuota.recibo.compat.service.js';
export { crearReciboEnTxCompat };

import {
    addDays,
    addMonths,
    format,
    isAfter,
    differenceInCalendarDays,
    differenceInCalendarMonths
} from 'date-fns';

import { Op } from 'sequelize';
// ❌ Evitamos import estático para no crear dependencia circular con credito.service
// import { actualizarEstadoCredito } from './credito.service.js';
import sequelize from '../../models/sequelize.js';
import { calcularPuntajeCliente } from '../puntaje.service.js';

// ⬇️ Impacto en caja
import CajaMovimiento from '../../models/CajaMovimiento.js';

/* ───────────────── Guards de negocio ───────────────── */

/**
 * Bloquea pagos sobre créditos ANULADOS.
 * Defensa backend: aunque el front muestre botones, el server debe rechazar.
 */
const assertNoPagoSiAnulado = ({ credito }) => {
    const estado = String(credito?.estado ?? '').trim().toLowerCase();
    if (estado === 'anulado' || estado === 'anulada') {
        const err = new Error('El crédito está ANULADO. No se permiten pagos ni liquidaciones.');
        err.status = 409;
        err.code = 'CREDITO_ANULADO';
        throw err;
    }
};

/**
 * Defensa: no permitir pagos si el crédito/cliente no están correctamente asociados.
 * Esto evita que se registren movimientos (pago/recibo/caja) y luego falle el armado de recibo/UI
 * por datos nulos (caso típico: créditos importados sin cobrador/zona).
 *
 * Nota: Zona puede ser null (se tolera), pero COBRADOR no: se usa en recibos/reportes.
 */
const assertClienteYCobradorValidos = ({ credito, cliente, cobrador }) => {
    if (!cliente) {
        const err = new Error('El crédito no tiene CLIENTE asociado. No se puede registrar el pago.');
        err.status = 409;
        err.code = 'CREDITO_SIN_CLIENTE';
        throw err;
    }

    const cobradorId = credito?.cobrador_id ?? null;
    if (!cobradorId || !cobrador) {
        const err = new Error(
            'El crédito no tiene COBRADOR asignado. Asigná un cobrador (y zona si corresponde) antes de cobrar.'
        );
        err.status = 409;
        err.code = 'CREDITO_SIN_COBRADOR';
        throw err;
    }
};

const assertFormaPagoValida = ({ medioPago, forma_pago_id }) => {
    if (!medioPago) {
        const err = new Error('Forma de pago inválida o inexistente.');
        err.status = 400;
        err.code = 'FORMA_PAGO_INVALIDA';
        err.details = { forma_pago_id };
        throw err;
    }
};

/**
 * ✅ IMPORTANTÍSIMO:
 * El puntaje crediticio NO debe tumbar un cobro.
 * Si falla (por datos nulos/importación, parse de fechas, etc.), se loguea y se sigue.
 */
const recalcularPuntajeClienteSafe = (clienteId) => {
    const id = Number(clienteId);
    if (!Number.isFinite(id) || id <= 0) return;

    Promise.resolve()
        .then(() => calcularPuntajeCliente(id))
        .catch((e) => {
            // log mínimo, sin romper el flujo de pago
            console.warn('[puntaje] No se pudo recalcular puntaje_crediticio:', {
                clienteId: id,
                message: e?.message
            });
        });
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
        const { actualizarEstadoCredito } = await import('../credito.service.js');
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

    // ✅ LIBRE: en Cuota.intereses_vencidos_acumulados guardamos la MORA "HOY" (ciclo actual),
    // no el acumulado total de ciclos. El acumulado total vive en el resumen exacto.
    if (esCreditoLibre(credito) || cuota.fecha_vencimiento === VTO_FICTICIO_LIBRE) {
        let moraLibreHoy = 0;

        try {
            const resumen = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyStr));
            moraLibreHoy = fix2(
                toNumber(resumen?.mora_pendiente_hoy ?? resumen?.mora_pendiente_total ?? 0)
            );
        } catch {
            // Fallback: si falla el resumen, usamos cálculo exacto (puede ser total),
            // antes que dejarlo en 0. Idealmente no debería fallar.
            const moraExacta = await calcularMoraPendienteLibreExacto({ credito, hoyYMD: hoyStr, t });
            moraLibreHoy = fix2(toNumber(moraExacta));
        }

        if (toNumber(cuota.intereses_vencidos_acumulados) !== moraLibreHoy) {
            await cuota.update({ intereses_vencidos_acumulados: moraLibreHoy }, { transaction: t });
        }
        return moraLibreHoy;
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

    // ✅ LIBRE: guardamos mora HOY en la cuota (ciclo actual)
    if (esCreditoLibre(credito)) {
        const cuotaLibre = await Cuota.findOne({
            where: { credito_id: creditoId },
            order: [['numero_cuota', 'ASC']],
            transaction: t
        });
        if (!cuotaLibre) return 0;

        let moraLibreHoy = 0;

        try {
            const resumen = await obtenerResumenLibrePorCredito(credito.id, ymdDate(hoyStr));
            moraLibreHoy = fix2(
                toNumber(resumen?.mora_pendiente_hoy ?? resumen?.mora_pendiente_total ?? 0)
            );
        } catch {
            const moraExacta = await calcularMoraPendienteLibreExacto({ credito, hoyYMD: hoyStr, t });
            moraLibreHoy = fix2(toNumber(moraExacta));
        }

        if (toNumber(cuotaLibre.intereses_vencidos_acumulados) !== moraLibreHoy) {
            await cuotaLibre.update({ intereses_vencidos_acumulados: moraLibreHoy }, { transaction: t });
        }
        return moraLibreHoy;
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
            a.fecha_vencimiento > b.fecha_vencimiento ? 1 : 0)
    );

    return filas;
};

/* ──────────────────────────────────────────────────────────────────────────
 * NUEVO: Ruta de cobro automática para el cobrador logueado
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
            const mod = await import('../../models/Zona.js');
            Zona = mod?.default ?? null;
        } catch {
            // ignore
        }

        // 2) fallback por index (si existe)
        if (!Zona) {
            try {
                const mod2 = await import('../../models/index.js');
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
            categoria,
            modalidad_credito: cr.modalidad_credito,
            tipo_credito: cr.tipo_credito,
            credito_estado: cr.estado,

            cuota_id: c.id,
            credito_id: c.credito_id,
            numero_cuota: c.numero_cuota,
            estado_cuota: c.estado,
            fecha_vencimiento: fv,
            dias_vencida: diasVencida,

            cliente_id: cl.id,
            cliente_nombre: cl.nombre,
            cliente_apellido: cl.apellido,
            cliente_dni: cl.dni ?? null,
            cliente_telefono: cl.telefono ?? null,
            cliente_telefono_secundario: cl.telefono_secundario ?? null,
            cliente_direccion: cl.direccion ?? null,
            zona_id,
            zona_nombre,

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
            continue;
        }

        const saldo_capital = fix2(cr.saldo_actual || 0);

        // ✅ Preferimos “HOY” si el helper lo expone; si no, caemos al total (compat).
        const resumenLibre = await obtenerResumenLibrePorCredito(cr.id, ymdDate(hoyY));

        const interes_pendiente_hoy = fix2(
            toNumber(resumenLibre?.interes_pendiente_hoy ?? resumenLibre?.interes_pendiente_total ?? 0)
        );
        const mora_pendiente_hoy = fix2(
            toNumber(resumenLibre?.mora_pendiente_hoy ?? resumenLibre?.mora_pendiente_total ?? 0)
        );

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

            cuota_id: cuotaOperable.id,
            credito_id: cr.id,
            numero_cuota: cuotaOperable.numero_cuota ?? null,

            fecha_vencimiento: fcp,
            dias_vencida: diasVencida,

            cliente_id: cl.id,
            cliente_nombre: cl.nombre,
            cliente_apellido: cl.apellido,
            cliente_dni: cl.dni ?? null,
            cliente_telefono: cl.telefono ?? null,
            cliente_telefono_secundario: cl.telefono_secundario ?? null,
            cliente_direccion: cl.direccion ?? null,
            zona_id,
            zona_nombre,

            saldo_capital,
            interes_pendiente_hoy,
            mora_pendiente_hoy,
            total_a_pagar_hoy
        });
    }

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
    rol_id = null,
    monto_pagado = null,      // ✅ para LIBRE: permite pagos parciales
    ciclo_libre = null        // ✅ opcional: forzar ciclo objetivo en LIBRE
}) => {
    const t = await sequelize.transaction();
    try {
        const cuota = await Cuota.findByPk(cuota_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (!cuota) throw new Error('Cuota no encontrada');

        const credito = await Credito.findByPk(cuota.credito_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!credito) throw new Error('Crédito asociado no encontrado');

        // ✅ Bloqueos de negocio
        assertNoPagoSiRefinanciado({ credito, cuota });
        assertNoPagoSiAnulado({ credito });

        const cliente = await Cliente.findByPk(credito.cliente_id, { transaction: t });
        const cobrador = await Usuario.findByPk(credito.cobrador_id, { transaction: t });
        const medioPago = await FormaPago.findByPk(forma_pago_id, { transaction: t });

        // ✅ Validaciones fuertes ANTES de registrar movimientos
        assertClienteYCobradorValidos({ credito, cliente, cobrador });
        assertFormaPagoValida({ medioPago, forma_pago_id });

        // —— LIBRE → delega a cuota.libre.service.js (mantiene core liviano) —— 
        if (esCreditoLibre(credito)) {
            const result = await pagarCuotaLibreEnTx({
                t,
                cuota,
                credito,
                cliente,
                cobrador,
                medioPago,
                forma_pago_id,
                descuento,
                descuento_scope,
                descuento_mora,
                observacion,
                usuario_id,
                rol_id,
                monto_pagado,
                ciclo_libre
            });

            await t.commit();

            // ✅ NO bloqueante / no rompe el cobro
            recalcularPuntajeClienteSafe(cliente?.id);

            return result;
        }

        // —— NO libre —— 
        const moraActual = await recalcularMoraCuota(cuota.id, t);

        const importeOriginal = fix2(cuota.importe_cuota);
        const descuentoPrevio = fix2(cuota.descuento_cuota);
        const principalPagadoPrevio = fix2(cuota.monto_pagado_acumulado);

        const isAdmin = Number(rol_id) === 1;
        const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
        const descuentoMoraBruto = scope === 'mora'
            ? (descuento_mora != null ? fix2(toNumber(descuento_mora)) : fix2(toNumber(descuento)))
            : fix2(toNumber(descuento));

        const descuentoMora = Math.min(Math.max(descuentoMoraBruto, 0), fix2(moraActual));
        const moraNeta = fix2(Math.max(moraActual - descuentoMora, 0));

        const saldoPrincipalTrasDescuento = Math.max(importeOriginal - descuentoPrevio - principalPagadoPrevio, 0);

        const netoAPagar = fix2(moraNeta + saldoPrincipalTrasDescuento);

        const pago = await Pago.create(
            { cuota_id, monto_pagado: netoAPagar, forma_pago_id, observacion, fecha_pago: todayYMD() },
            { transaction: t }
        );

        const moraCobrada = Math.min(netoAPagar, moraNeta);
        const principalPagado = Math.max(netoAPagar - moraCobrada, 0);

        cuota.intereses_vencidos_acumulados = fix2(Math.max(moraNeta - moraCobrada, 0));
        cuota.monto_pagado_acumulado = fix2(principalPagadoPrevio + principalPagado);
        cuota.descuento_cuota = descuentoPrevio;
        cuota.estado = 'pagada';
        cuota.forma_pago_id = forma_pago_id;
        await cuota.save({ transaction: t });

        credito.interes_acumulado = fix2(toNumber(credito.interes_acumulado) + moraCobrada);
        credito.saldo_actual = fix2(Math.max(toNumber(credito.saldo_actual) - principalPagado, 0));
        await credito.save({ transaction: t });

        const totalAntes = fix2(saldoPrincipalTrasDescuento + moraActual);
        const totalDespues = 0;

        const datosRecibo = armarDatosRecibo({
            cliente,
            cobrador,
            pago,
            cuota,
            credito,
            medioPagoNombre: medioPago?.nombre ?? 'N/D',
            importeOriginalCuota: importeOriginal,
            descuentoAplicado: descuentoMora,
            moraCobrada,
            principalPagado,
            saldoPrincipalAntes: Math.max(importeOriginal - descuentoPrevio - principalPagadoPrevio, 0),
            saldoPrincipalDespues: 0,
            saldoCreditoAntes: fix2(toNumber(credito.saldo_actual) + principalPagado),
            saldoCreditoDespues: toNumber(credito.saldo_actual),
            interesCicloCobrado: 0,
            saldoCuotaAnterior: totalAntes,
            saldoCuotaActual: totalDespues,
            saldoMoraRestante: 0
        });

        // ✅ Recibo robusto si la DB no tiene Recibo.ciclo_libre
        const recibo = await crearReciboEnTxCompat({ t, datosRecibo });

        const plain = recibo.get({ plain: true });
        plain.modalidad_credito = credito.modalidad_credito;
        const ui = buildReciboUI(plain);
        recibo.setDataValue('recibo_ui', ui);
        recibo.setDataValue('modalidad_credito', credito.modalidad_credito);

        await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });

        const { actualizarEstadoCredito } = await import('../credito.service.js');
        await actualizarEstadoCredito(credito.id, t);

        await t.commit();

        // ✅ NO bloqueante / no rompe el cobro
        recalcularPuntajeClienteSafe(cliente?.id);

        return { cuota, recibo };
    } catch (err) {
        if (t?.finished !== 'commit') {
            try { await t.rollback(); } catch (_) { }
        }
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

        const credito = await Credito.findByPk(cuota.credito_id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!credito) throw new Error('Crédito asociado no encontrado');

        // ✅ Bloqueos de negocio
        assertNoPagoSiRefinanciado({ credito, cuota });
        assertNoPagoSiAnulado({ credito });

        const cliente = await Cliente.findByPk(credito.cliente_id, { transaction: t });
        const cobrador = await Usuario.findByPk(credito.cobrador_id, { transaction: t });
        const medioPago = await FormaPago.findByPk(forma_pago_id, { transaction: t });

        // ✅ Validaciones fuertes ANTES de registrar movimientos
        assertClienteYCobradorValidos({ credito, cliente, cobrador });
        assertFormaPagoValida({ medioPago, forma_pago_id });

        // —— LIBRE → delega a cuota.libre.service.js —— 
        if (esCreditoLibre(credito)) {
            const result = await registrarPagoParcialLibreEnTx({
                t,
                cuota,
                credito,
                cliente,
                cobrador,
                medioPago,
                cuota_id,
                monto_pagado,
                forma_pago_id,
                observacion,
                descuento,
                descuento_scope,
                descuento_mora,
                usuario_id,
                rol_id
            });

            await t.commit();

            // ✅ NO bloqueante / no rompe el cobro
            recalcularPuntajeClienteSafe(credito?.cliente_id);

            return result;
        }

        // —— NO libre —— (sin cambios sustanciales)
        const moraActual = await recalcularMoraCuota(cuota.id, t);

        const importeCuota = fix2(cuota.importe_cuota);
        const descuentoPrevio = fix2(cuota.descuento_cuota);
        const principalPagadoPrevio = fix2(cuota.monto_pagado_acumulado);
        const saldoPrincipalAntes = Math.max(importeCuota - descuentoPrevio - principalPagadoPrevio, 0);
        const saldoCreditoAntes = fix2(credito.saldo_actual);

        const isAdmin = Number(rol_id) === 1;
        const scope = isAdmin ? 'mora' : (String(descuento_scope || '').toLowerCase() || null);
        const descMoraRaw = scope === 'mora'
            ? (descuento_mora != null ? fix2(toNumber(descuento_mora)) : fix2(toNumber(descuento)))
            : fix2(toNumber(descuento));

        const descuentoMora = Math.min(Math.max(descMoraRaw, 0), fix2(moraActual));
        const moraNeta = fix2(Math.max(moraActual - descuentoMora, 0));

        const saldoPrincipalTrasDescuento = Math.max(importeCuota - descuentoPrevio - principalPagadoPrevio, 0);

        const pago = await Pago.create(
            { cuota_id, monto_pagado: fix2(monto_pagado), forma_pago_id, observacion, fecha_pago: todayYMD() },
            { transaction: t }
        );

        const aMora = Math.min(fix2(monto_pagado), moraNeta);
        const aPrincipal = Math.max(fix2(monto_pagado) - aMora, 0);
        const principalEfectivo = Math.min(aPrincipal, saldoPrincipalTrasDescuento);

        cuota.intereses_vencidos_acumulados = fix2(Math.max(moraNeta - aMora, 0));
        cuota.monto_pagado_acumulado = fix2(principalPagadoPrevio + principalEfectivo);
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

        const totalAntes = fix2(saldoPrincipalTrasDescuento + moraActual);
        const totalDespues = fix2(principalPendienteDespues + moraRestante);

        const datosRecibo = armarDatosRecibo({
            cliente,
            cobrador,
            pago,
            cuota,
            credito,
            medioPagoNombre: medioPago?.nombre ?? 'N/D',
            importeOriginalCuota: importeCuota,
            descuentoAplicado: descuentoMora,
            moraCobrada: aMora,
            principalPagado: principalEfectivo,
            saldoPrincipalAntes,
            saldoPrincipalDespues: fix2(principalPendienteDespues),
            saldoCreditoAntes,
            saldoCreditoDespues: toNumber(credito.saldo_actual),
            interesCicloCobrado: 0,
            saldoCuotaAnterior: totalAntes,
            saldoCuotaActual: totalDespues,
            saldoMoraRestante: moraRestante
        });

        // ✅ Recibo robusto si la DB no tiene Recibo.ciclo_libre
        const recibo = await crearReciboEnTxCompat({ t, datosRecibo });

        const plain = recibo.get({ plain: true });
        plain.modalidad_credito = credito.modalidad_credito;
        const ui = buildReciboUI(plain);
        recibo.setDataValue('recibo_ui', ui);
        recibo.setDataValue('modalidad_credito', credito.modalidad_credito);

        await registrarIngresoDesdeReciboEnTx({ t, recibo, forma_pago_id, usuario_id });

        const { actualizarEstadoCredito } = await import('../credito.service.js');
        await actualizarEstadoCredito(cuota.credito_id, t);

        await t.commit();

        // ✅ NO bloqueante / no rompe el cobro
        recalcularPuntajeClienteSafe(credito?.cliente_id);

        return { cuota, recibo };
    } catch (err) {
        if (t?.finished !== 'commit') {
            try { await t.rollback(); } catch (_) { }
        }
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

        const tienePagos = await Pago.count({ where: { cuota_id: id }, transaction: t });
        if (tienePagos > 0) {
            await t.rollback();
            const err = new Error('No se puede eliminar la cuota: tiene pagos registrados.');
            err.status = 409;
            throw err;
        }

        const recibos = await findAllReciboSafe({
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
