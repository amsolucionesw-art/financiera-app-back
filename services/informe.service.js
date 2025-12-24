// backend/src/services/informe.service.js

import {
    Cliente,
    Credito,
    Cuota,
    Pago,
    FormaPago,
    Usuario,
    Zona
} from '../models/index.js';
import { Op, literal, where, col } from 'sequelize';
import { buildFilters } from '../utils/buildFilters.js';
import { actualizarCuotasVencidas } from './cuota.service.js';

/* ──────────────────────────────────────────────────────────────
 * Config TZ (coherencia con resto del backend)
 * ────────────────────────────────────────────────────────────── */
const APP_TZ = process.env.APP_TZ || 'America/Argentina/Tucuman';
const todayYMD = () =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: APP_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());

/* ──────────────────────────────────────────────────────────────
 * Helpers locales
 * ────────────────────────────────────────────────────────────── */

/** Normaliza booleanos recibidos como string o número. */
const asBool = (v) => {
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1' || v === 'true') return true;
    if (v === 0 || v === '0' || v === 'false') return false;
    return undefined;
};

/**
 * Construye un filtro de rango de fechas seguro (YYYY-MM-DD).
 * - campo: nombre del campo en BD
 * - query: { desde, hasta }
 */
const dateRangeWhere = (campo, query = {}) => {
    const { desde, hasta } = query || {};
    if (!desde && !hasta) return undefined;
    const w = {};
    if (desde) w[Op.gte] = desde;
    if (hasta) w[Op.lte] = hasta;
    return { [campo]: w };
};

/**
 * Construye un filtro de rango aplicado sobre **varios campos** usando OR.
 * Ej.: OR(fecha_acreditacion in rango, fecha_compromiso_pago in rango)
 */
const dateRangeWhereOr = (campos = [], query = {}) => {
    const { desde, hasta } = query || {};

    if (!Array.isArray(campos) || campos.length === 0) return undefined;
    if (!desde && !hasta) return undefined;

    const w = {};
    if (desde) w[Op.gte] = desde;
    if (hasta) w[Op.lte] = hasta;

    return {
        [Op.or]: campos.map((campo) => ({ [campo]: w }))
    };
};

/**
 * Filtro "search" genérico: q contra nombre/apellido del cliente.
 * clienteAlias:
 *   - en créditos: 'cliente'
 *   - en cuotas:   'credito->cliente'
 */
const addGenericSearchForCliente = (q, clienteAlias = 'cliente') => {
    if (!q) return undefined;
    const like = { [Op.iLike]: `%${q}%` };
    const nombreCol = col(`${clienteAlias}.nombre`);
    const apellidoCol = col(`${clienteAlias}.apellido`);
    return {
        [Op.or]: [
            where(nombreCol, like),
            where(apellidoCol, like)
        ]
    };
};

/* ──────────────────────────────────────────────────────────────
 * Selector de rango por fecha (solo Créditos)
 * ────────────────────────────────────────────────────────────── */

const CREDITOS_RANGO_MAP = {
    solicitud: ['fecha_solicitud'],
    acreditacion: ['fecha_acreditacion'],
    compromiso: ['fecha_compromiso_pago'],
    acreditacion_compromiso: ['fecha_acreditacion', 'fecha_compromiso_pago']
};

/** Normaliza el valor del selector del front */
const normalizeRangoFechaCredito = (v) => {
    if (!v) return 'acreditacion_compromiso';
    const s = String(v).trim().toLowerCase();

    if (s === 'solicitud' || s === 'fecha_solicitud') return 'solicitud';
    if (s === 'acreditacion' || s === 'fecha_acreditacion') return 'acreditacion';
    if (s === 'compromiso' || s === 'fecha_compromiso_pago') return 'compromiso';

    if (s === 'acreditacion_compromiso' || s === 'acreditacion-o-compromiso' || s === 'acreditacion_compromiso_pago') {
        return 'acreditacion_compromiso';
    }

    if (
        s === 'otorgamiento' ||
        s === 'fecha_otorgamiento' ||
        s === 'actualizacion' ||
        s === 'ultima_actualizacion' ||
        s === 'fecha_ultima_actualizacion'
    ) {
        return 'acreditacion_compromiso';
    }

    return 'acreditacion_compromiso';
};

/* ──────────────────────────────────────────────────────────────
 * Helpers: Mora diaria + días atraso (cuotas)
 * ────────────────────────────────────────────────────────────── */

const MORA_DIARIA_PCT = 2.5;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const toNumberMaybe = (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (!s) return null;
    const normalized = s
        .replace(/\s/g, '')
        .replace(/\./g, '')
        .replace(/,/g, '.');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
};

const toYMD = (v) => {
    if (!v) return null;
    const s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const ymdToUtcMidnightMs = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return NaN;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    return Date.UTC(y, mo, d);
};

const daysDiffYMD = (fromYMD, toYMDStr) => {
    const a = ymdToUtcMidnightMs(fromYMD);
    const b = ymdToUtcMidnightMs(toYMDStr);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    const diff = Math.floor((b - a) / 86400000);
    return diff > 0 ? diff : 0;
};

const isOverdueByDate = (fechaVenc) => {
    const fv = toYMD(fechaVenc);
    if (!fv) return false;
    return fv < todayYMD();
};

const unpaidAmount = (importeCuota, montoPagadoAcum) => {
    const imp = Number(importeCuota || 0);
    const pag = Number(montoPagadoAcum || 0);
    const diff = imp - pag;
    return diff > 0.00001 ? diff : 0;
};

/**
 * Mora por día (unitaria):
 * - 2,5% sobre importe_cuota
 * - Solo si está vencida por fecha y aún hay deuda
 */
const computeMoraPorDiaMonto = (dtoPlain, montoPagadoAcumulado) => {
    if (!dtoPlain) return null;

    // Si el modelo ya trae “mora por día”, lo respetamos
    const candidates = [
        'mora_por_dia_monto',
        'mora_por_dia',
        'mora_dia',
        'moraDiariaMonto',
        'moraDiaria',
        'moraPorDia',
        'moraDia'
    ];

    for (const k of candidates) {
        if (Object.prototype.hasOwnProperty.call(dtoPlain, k)) {
            const n = toNumberMaybe(dtoPlain[k]);
            if (n !== null) return round2(n);
        }
    }

    const overdue = isOverdueByDate(dtoPlain.fecha_vencimiento);
    if (!overdue) return null;

    const imp = Number(dtoPlain.importe_cuota || 0);
    if (!Number.isFinite(imp) || imp <= 0) return null;

    const pendiente = unpaidAmount(imp, montoPagadoAcumulado);
    if (pendiente <= 0) return null;

    return round2(imp * (MORA_DIARIA_PCT / 100));
};

/**
 * Días de atraso (TZ Tucumán):
 * - Solo si está vencida por fecha y tiene deuda pendiente.
 * - Caso contrario: 0
 */
const computeDiasAtraso = (dtoPlain, montoPagadoAcumulado) => {
    if (!dtoPlain) return 0;

    const overdue = isOverdueByDate(dtoPlain.fecha_vencimiento);
    if (!overdue) return 0;

    const imp = Number(dtoPlain.importe_cuota || 0);
    const pendiente = unpaidAmount(imp, montoPagadoAcumulado);
    if (pendiente <= 0) return 0;

    const fv = toYMD(dtoPlain.fecha_vencimiento);
    if (!fv) return 0;

    return daysDiffYMD(fv, todayYMD());
};

/**
 * ✅ Mora acumulada a hoy:
 * - mora_por_dia_monto * dias_atraso
 * - Si días_atraso=0 => null
 */
const computeMoraAcumuladaMonto = (moraPorDiaMonto, diasAtraso) => {
    const d = Number(diasAtraso || 0);
    const m = Number(moraPorDiaMonto || 0);
    if (!Number.isFinite(d) || d <= 0) return null;
    if (!Number.isFinite(m) || m <= 0) return null;
    return round2(m * d);
};

/* ──────────────────────────────────────────────────────────────
 * Servicio principal de informes
 * ────────────────────────────────────────────────────────────── */

export const generarInforme = async (tipo = 'clientes', query = {}) => {
    switch (tipo) {
        /* ──────────── CLIENTES ──────────── */
        case 'clientes': {
            const onlyPend = asBool(query.conCreditosPendientes);

            const whereCliente = {
                ...buildFilters(query, {
                    zonaId: { field: 'zona', type: 'eq' },
                    cobradorId: { field: 'cobrador', type: 'eq' }
                })
            };

            if (query.q) {
                const like = { [Op.iLike]: `%${query.q}%` };
                whereCliente[Op.or] = [
                    { nombre: like },
                    { apellido: like }
                ];
            }

            const includeArr = [
                {
                    model: Credito,
                    as: 'creditos',
                    attributes: ['id', 'estado'],
                    required: !!onlyPend,
                    where: onlyPend
                        ? { estado: { [Op.notIn]: ['pagado', 'anulado', 'refinanciado'] } }
                        : undefined
                },
                {
                    model: Usuario,
                    as: 'cobradorUsuario',
                    attributes: ['nombre_completo']
                },
                {
                    model: Zona,
                    as: 'clienteZona',
                    attributes: ['nombre']
                }
            ];

            const clientes = await Cliente.findAll({
                where: whereCliente,
                include: includeArr,
                order: [
                    ['apellido', 'ASC'],
                    ['nombre', 'ASC']
                ],
                raw: false
            });

            return clientes.map(c => {
                const dto = c.get({ plain: true });
                const { creditos, cobradorUsuario, clienteZona, ...rest } = dto;

                const numeroCreditos = Array.isArray(creditos) ? creditos.length : 0;

                return {
                    ...rest,
                    cobrador: cobradorUsuario?.nombre_completo || '',
                    zona: clienteZona?.nombre || '',
                    numeroCreditos
                };
            });
        }

        /* ──────────── CREDITOS ──────────── */
        case 'creditos': {
            const onlyPend = asBool(query.conCreditosPendientes);

            const queryForFilters = { ...query };
            delete queryForFilters.rangoFechaCredito;

            const whereCreditoBase = {
                ...buildFilters(queryForFilters, {
                    cobradorId: { field: 'cobrador_id', type: 'eq' },
                    clienteId: { field: 'cliente_id', type: 'eq' },
                    zonaId: { field: '$cliente.zona$', type: 'eq' },
                    estadoCredito: { field: 'estado', type: 'in' },
                    modalidad: { field: 'modalidad_credito', type: 'in' },
                    tipoCredito: { field: 'tipo_credito', type: 'in' }
                })
            };

            if (onlyPend === true) {
                whereCreditoBase.estado = { [Op.notIn]: ['pagado', 'anulado', 'refinanciado'] };
            }

            const rangoKey = normalizeRangoFechaCredito(query.rangoFechaCredito);
            const camposRango = CREDITOS_RANGO_MAP[rangoKey] || CREDITOS_RANGO_MAP.acreditacion_compromiso;

            const whereRango = dateRangeWhereOr(camposRango, query);

            const whereCredito = whereRango
                ? { [Op.and]: [whereCreditoBase, whereRango] }
                : whereCreditoBase;

            const whereSearch = addGenericSearchForCliente(query.q, 'cliente');

            const whereFinal = whereSearch
                ? { [Op.and]: [whereCredito, whereSearch] }
                : whereCredito;

            const creditos = await Credito.findAll({
                where: whereFinal,
                include: [
                    {
                        model: Cliente,
                        as: 'cliente',
                        attributes: ['nombre', 'apellido'],
                        include: [
                            {
                                model: Zona,
                                as: 'clienteZona',
                                attributes: ['nombre']
                            }
                        ]
                    },
                    {
                        model: Usuario,
                        as: 'cobradorCredito',
                        attributes: ['nombre_completo']
                    }
                ],
                order: [['id', 'DESC']],
                raw: false
            });

            return creditos.map(cr => {
                const dto = cr.get({ plain: true });
                const { cliente, cobradorCredito, cliente_id, cobrador_id, ...rest } = dto;

                return {
                    ...rest,
                    cliente: cliente ? `${cliente.nombre} ${cliente.apellido}` : '',
                    zona: cliente?.clienteZona?.nombre ?? '',
                    cobrador: cobradorCredito?.nombre_completo ?? ''
                };
            });
        }

        /* ──────────── CUOTAS ──────────── */
        case 'cuotas': {
            await actualizarCuotasVencidas();

            const whereCuotaBase = {
                ...buildFilters(query, {
                    estadoCuota: { field: 'estado', type: 'in' },
                    hoy: { field: 'fecha_vencimiento', type: 'today' }
                }),
                ...dateRangeWhere('fecha_vencimiento', query)
            };

            if (query.formaPagoId) {
                whereCuotaBase['$pagos.forma_pago_id$'] = Number(query.formaPagoId);
            }

            const whereRel = [];
            if (query.cobradorId) {
                whereRel.push({ '$credito.cobrador_id$': Number(query.cobradorId) });
            }
            if (query.clienteId) {
                whereRel.push({ '$credito.cliente_id$': Number(query.clienteId) });
            }
            if (query.zonaId) {
                whereRel.push({ '$credito.cliente.zona$': Number(query.zonaId) });
            }

            const whereFinalBase = whereRel.length
                ? { [Op.and]: [whereCuotaBase, ...whereRel] }
                : whereCuotaBase;

            const whereSearch = addGenericSearchForCliente(query.q, 'credito->cliente');

            const whereFinal = whereSearch
                ? { [Op.and]: [whereFinalBase, whereSearch] }
                : whereFinalBase;

            const cuotas = await Cuota.findAll({
                where: whereFinal,
                include: [
                    {
                        model: Credito,
                        as: 'credito',
                        required: true,
                        include: [
                            {
                                model: Cliente,
                                as: 'cliente',
                                attributes: ['nombre', 'apellido'],
                                include: [
                                    {
                                        model: Zona,
                                        as: 'clienteZona',
                                        attributes: ['nombre']
                                    }
                                ]
                            },
                            {
                                model: Usuario,
                                as: 'cobradorCredito',
                                attributes: ['nombre_completo']
                            }
                        ]
                    },
                    {
                        model: Pago,
                        as: 'pagos',
                        attributes: ['id', 'monto_pagado', 'fecha_pago', 'forma_pago_id'],
                        include: [{ model: FormaPago, as: 'formaPago', attributes: ['nombre'] }]
                    }
                ],
                order: [['fecha_vencimiento', 'ASC'], ['numero_cuota', 'ASC']],
                raw: false
            });

            return cuotas.map(cuota => {
                const dto = cuota.get({ plain: true });

                const formasPagoUnicas = (dto.pagos || [])
                    .map(p => p.formaPago?.nombre)
                    .filter(Boolean)
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .join(', ');

                const montoPagadoAcumulado = (dto.pagos || [])
                    .reduce((acc, p) => acc + Number(p.monto_pagado || 0), 0);

                const diasAtraso = computeDiasAtraso(dto, montoPagadoAcumulado);

                // ✅ mora por día (unitaria)
                const moraPorDiaMonto = computeMoraPorDiaMonto(dto, montoPagadoAcumulado);

                // ✅ mora acumulada hasta hoy (lo que ustedes esperan ver en la tabla)
                const moraAcumuladaMonto = computeMoraAcumuladaMonto(moraPorDiaMonto, diasAtraso);

                return {
                    id: dto.id,
                    numero_cuota: dto.numero_cuota,
                    importe_cuota: Number(dto.importe_cuota || 0),
                    fecha_vencimiento: dto.fecha_vencimiento,
                    estado: dto.estado,
                    cliente: dto.credito?.cliente
                        ? `${dto.credito.cliente.nombre} ${dto.credito.cliente.apellido}`
                        : '',
                    zona: dto.credito?.cliente?.clienteZona?.nombre ?? '',
                    cobrador: dto.credito?.cobradorCredito?.nombre_completo ?? '',
                    formasPago: formasPagoUnicas,
                    monto_pagado_acumulado: Number(montoPagadoAcumulado.toFixed(2)),

                    // 👇 En tu tabla actual “Mora diaria” ya está usando esta key,
                    // así que la llenamos con la mora ACUMULADA.
                    mora_diaria_monto: moraAcumuladaMonto,

                    // 👇 Extra opcional por si luego quieren mostrar “por día”
                    mora_por_dia_monto: moraPorDiaMonto,

                    dias_atraso: diasAtraso
                };
            });
        }

        default:
            return [];
    }
};
