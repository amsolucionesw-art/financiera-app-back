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
    if (!Array.isArray(caminos = campos) || caminos.length === 0) return undefined;
    if (!desde && !hasta) return undefined;

    const w = {};
    if (desde) w[Op.gte] = desde;
    if (hasta) w[Op.lte] = hasta;

    return {
        [Op.or]: caminos.map((campo) => ({ [campo]: w }))
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
 * Servicio principal de informes
 * ────────────────────────────────────────────────────────────── */

export const generarInforme = async (tipo = 'clientes', query = {}) => {
    switch (tipo) {
        /* ──────────── CLIENTES ──────────── */
        case 'clientes': {
            const onlyPend = asBool(query.conCreditosPendientes);

            // Filtros de cliente por zona / cobrador (guardados en campos del cliente)
            const whereCliente = {
                ...buildFilters(query, {
                    zonaId: { field: 'zona', type: 'eq' },
                    cobradorId: { field: 'cobrador', type: 'eq' }
                })
            };

            // Búsqueda libre q por nombre/apellido
            if (query.q) {
                const like = { [Op.iLike]: `%${query.q}%` };
                whereCliente[Op.or] = [
                    { nombre: like },
                    { apellido: like }
                ];
            }

            // Include: si piden “solo con créditos pendientes”, incluimos solo los NO pagados/anulados/refinanciados.
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

                // Si onlyPend => el include ya trae filtrados. Si no, contamos todos.
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

            // Mapeo de filtros al esquema real
            const whereCreditoBase = {
                ...buildFilters(query, {
                    cobradorId:     { field: 'cobrador_id', type: 'eq' },
                    clienteId:      { field: 'cliente_id', type: 'eq' },
                    zonaId:         { field: '$cliente.zona$', type: 'eq' }, // via include
                    estadoCredito:  { field: 'estado', type: 'in' },
                    modalidad:      { field: 'modalidad_credito', type: 'in' },
                    tipoCredito:    { field: 'tipo_credito', type: 'in' }
                })
            };

            if (onlyPend === true) {
                // Consideramos “pendientes” todo lo no pagado/anulado/refinanciado
                whereCreditoBase.estado = { [Op.notIn]: ['pagado', 'anulado', 'refinanciado'] };
            }

            // Rango de fechas aplicado a (fecha_acreditacion OR fecha_compromiso_pago)
            const whereRango = dateRangeWhereOr(
                ['fecha_acreditacion', 'fecha_compromiso_pago'],
                query
            );

            const whereCredito = whereRango
                ? { [Op.and]: [whereCreditoBase, whereRango] }
                : whereCreditoBase;

            // Búsqueda libre por cliente
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
                        attributes: ['nombre', 'apellido', 'zona']
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
                    zona: cliente?.zona ?? '',
                    cobrador: cobradorCredito?.nombre_completo ?? ''
                };
            });
        }

        /* ──────────── CUOTAS ──────────── */
        case 'cuotas': {
            // Antes de calcular, aseguramos que las cuotas estén actualizadas (vencidas)
            await actualizarCuotasVencidas();

            const whereCuotaBase = {
                ...buildFilters(query, {
                    estadoCuota: { field: 'estado', type: 'in' },
                    // si tu buildFilters soporta 'today' para YMD en TZ, se usa. Si no, quitar.
                    hoy:         { field: 'fecha_vencimiento', type: 'today' }
                }),
                // rango por fecha de vencimiento
                ...dateRangeWhere('fecha_vencimiento', query)
            };

            // Filtro por forma de pago (en pagos asociados a la cuota)
            if (query.formaPagoId) {
                whereCuotaBase['$pagos.forma_pago_id$'] = Number(query.formaPagoId);
            }

            // Relacionales desde el crédito/cliente
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

            // Búsqueda libre por cliente (alias anidado)
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
                            { model: Cliente, as: 'cliente', attributes: ['nombre', 'apellido', 'zona'] },
                            { model: Usuario, as: 'cobradorCredito', attributes: ['nombre_completo'] }
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

                return {
                    id: dto.id,
                    numero_cuota: dto.numero_cuota,
                    importe_cuota: Number(dto.importe_cuota || 0),
                    fecha_vencimiento: dto.fecha_vencimiento,
                    estado: dto.estado,
                    cliente: dto.credito?.cliente
                        ? `${dto.credito.cliente.nombre} ${dto.credito.cliente.apellido}`
                        : '',
                    zona: dto.credito?.cliente?.zona ?? '',
                    cobrador: dto.credito?.cobradorCredito?.nombre_completo ?? '',
                    formasPago: formasPagoUnicas,
                    monto_pagado_acumulado: Number(montoPagadoAcumulado.toFixed(2))
                };
            });
        }

        default:
            return [];
    }
};