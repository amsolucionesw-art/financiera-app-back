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
 * Helpers locales
 * ────────────────────────────────────────────────────────────── */

/**
 * Normaliza booleanos recibidos como string o número.
 * 'true'/'1'/1 => true | 'false'/'0'/0 => false
 */
const asBool = (v) => {
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1' || v === 'true') return true;
    if (v === 0 || v === '0' || v === 'false') return false;
    return undefined;
};

/**
 * Construye un filtro de rango de fechas seguro en UTC (YYYY-MM-DD).
 * - campo: nombre del campo en BD
 * - query: { desde, hasta }
 */
const dateRangeWhere = (campo, query = {}) => {
    const { desde, hasta } = query || {};
    if (!desde && !hasta) return undefined;

    const w = {};
    if (desde) w[Op.gte] = desde; // se espera YYYY-MM-DD
    if (hasta) w[Op.lte] = hasta;
    return { [campo]: w };
};

/**
 * Filtro "search" genérico: q contra nombre/apellido del cliente.
 * Permite indicar el alias/route del include:
 *   - créditos: 'cliente'
 *   - cuotas:   'credito->cliente'
 */
const addGenericSearchForCliente = (q, clienteAlias = 'cliente') => {
    if (!q) return undefined;
    const like = { [Op.iLike]: `%${q}%` };
    // Para nested include, Sequelize usa "credito->cliente.campo"
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

            // Include básico; si piden "solo con créditos pendientes", pedimos include required
            const includeArr = [
                {
                    model: Credito,
                    as: 'creditos',
                    attributes: ['id', 'estado'],
                    required: !!onlyPend,
                    where: onlyPend
                        ? { estado: { [Op.notIn]: ['pagado', 'vencido', 'anulado'] } }
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
            const whereCredito = {
                ...buildFilters(query, {
                    cobradorId: { field: 'cobrador_id', type: 'eq' },
                    clienteId: { field: 'cliente_id', type: 'eq' },
                    zonaId: { field: '$cliente.zona$', type: 'eq' },
                    estadoCredito: { field: 'estado', type: 'in' },
                    modalidad: { field: 'modalidad', type: 'in' }
                }),
                // rango por fecha de alta del crédito (si se provee)
                ...dateRangeWhere('fecha_otorgamiento', query)
            };

            if (onlyPend === true) {
                whereCredito.estado = 'pendiente';
            }

            // búsqueda libre por cliente (alias directo)
            const whereSearch = addGenericSearchForCliente(query.q, 'cliente');

            const creditos = await Credito.findAll({
                where: whereSearch ? { [Op.and]: [whereCredito, whereSearch] } : whereCredito,
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
            // Actualiza estados vencidos antes de calcular informe
            await actualizarCuotasVencidas();

            const whereCuotaBase = {
                ...buildFilters(query, {
                    estadoCuota: { field: 'estado', type: 'in' },
                    // filtro especial "hoy" (si tu buildFilters soporta 'today')
                    hoy: { field: 'fecha_vencimiento', type: 'today' }
                }),
                // rango por fecha de vencimiento (si se provee)
                ...dateRangeWhere('fecha_vencimiento', query)
            };

            // Filtros relacionales: por forma de pago de los pagos registrados sobre la cuota
            if (query.formaPagoId) {
                whereCuotaBase['$pagos.forma_pago_id$'] = query.formaPagoId;
            }

            // Filtros relacionales adicionales: cobrador/cliente/zona desde el crédito->cliente
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

            const whereFinal = whereRel.length
                ? { [Op.and]: [whereCuotaBase, ...whereRel] }
                : whereCuotaBase;

            // búsqueda libre por cliente (alias anidado)
            const whereSearch = addGenericSearchForCliente(query.q, 'credito->cliente');

            const cuotas = await Cuota.findAll({
                where: whereSearch ? { [Op.and]: [whereFinal, whereSearch] } : whereFinal,
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
                        // ⚠️ columnas reales en tu BD
                        attributes: ['id', 'monto_pagado', 'fecha_pago', 'forma_pago_id'],
                        include: [
                            { model: FormaPago, as: 'formaPago', attributes: ['nombre'] }
                        ]
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
                    importe_cuota: dto.importe_cuota,
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
