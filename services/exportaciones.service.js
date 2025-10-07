// backend/src/services/exportaciones.service.js
import ExcelJS from 'exceljs';
import { Op } from 'sequelize';
import Compra from '../models/Compra.js';
import Recibo from '../models/Recibo.js';
import Cuota from '../models/Cuota.js';
import { Cliente, Credito } from '../models/associations.js';

const asYMD = (s) => {
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

const rango = ({ desde, hasta, mes, anio }) => {
    const where = {};
    if (mes && anio) {
        // YYYY-MM-01 hasta < +1 mes
        const d = `${anio}-${String(mes).padStart(2, '0')}-01`;
        where[Op.gte] = d;
        // usamos un < (menor estricto) al primer día del mes siguiente
        const next = new Date(`${d}T00:00:00Z`);
        next.setUTCMonth(next.getUTCMonth() + 1);
        const yyyy = next.getUTCFullYear();
        const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(next.getUTCDate()).padStart(2, '0');
        where[Op.lt] = `${yyyy}-${mm}-${dd}`;
    } else {
        const d = asYMD(desde);
        const h = asYMD(hasta);
        if (d) where[Op.gte] = d;
        if (h) where[Op.lte] = h;
    }
    return where;
};

// ====== Helpers VENTAS
const resolveFechaFinFinanciacion = async (credito_id) => {
    if (!credito_id) return null;
    const ultimaCuota = await Cuota.findOne({
        where: { credito_id },
        order: [['fecha_vencimiento', 'DESC']],
        attributes: ['fecha_vencimiento'],
        raw: true
    });
    return ultimaCuota?.fecha_vencimiento ?? null;
};

const safeNum = (v) => Number(v || 0);
const fix2 = (n) => Number((safeNum(n)).toFixed(2));

export const exportVentasYCompras = async (req, res) => {
    try {
        const { desde, hasta, mes, anio } = req.query || {};
        const whereFechasCompras = {};
        const fr = rango({ desde, hasta, mes, anio });
        if (fr[Op.gte] || fr[Op.lte] || fr[Op.lt]) {
            whereFechasCompras.fecha_imputacion = fr;
        }

        // === 1) OBTENER COMPRAS
        const compras = await Compra.findAll({
            where: whereFechasCompras,
            order: [['fecha_imputacion', 'ASC'], ['id', 'ASC']],
            raw: true
        });

        // === 2) OBTENER VENTAS
        // Usamos RECIBOS como "ventas" (tienen principal, mora, interes de ciclo, cobrador, medio pago).
        const whereRecibo = {};
        if (fr[Op.gte] || fr[Op.lte] || fr[Op.lt]) {
            whereRecibo.fecha = fr;
        }

        const recibos = await Recibo.findAll({
            where: whereRecibo,
            order: [['fecha', 'ASC'], ['numero_recibo', 'ASC']],
            raw: true
        });

        // Pre-carga de CLIENTES para DNI/CUIT si está disponible
        const clienteIds = [...new Set(recibos.map(r => r.cliente_id))].filter(Boolean);
        const clientesMap = {};
        if (clienteIds.length) {
            const clientes = await Cliente.findAll({ where: { id: clienteIds } });
            for (const c of clientes) {
                clientesMap[c.id] = c.toJSON();
            }
        }

        // Mapa credito_id por recibo (desde cuota)
        const cuotaIds = [...new Set(recibos.map(r => r.cuota_id))].filter(Boolean);
        const cuotas = await Cuota.findAll({ where: { id: cuotaIds }, raw: true });
        const cuotaById = {};
        for (const q of cuotas) cuotaById[q.id] = q;

        const creditoIds = [...new Set(cuotas.map(q => q.credito_id))].filter(Boolean);
        const creditos = await Credito.findAll({ where: { id: creditoIds }, raw: true });
        const creditoById = {};
        for (const cr of creditos) creditoById[cr.id] = cr;

        // Resolver fecha fin financiación por crédito (max vencimiento)
        const fechaFinPorCredito = {};
        for (const cr of creditos) {
            fechaFinPorCredito[cr.id] = await resolveFechaFinFinanciacion(cr.id);
        }

        // === 3) ARMAR EXCEL
        const wb = new ExcelJS.Workbook();
        const wsCompras = wb.addWorksheet('Compras');
        const wsVentas = wb.addWorksheet('Ventas');

        // ----- Hoja Compras -----
        wsCompras.columns = [
            { header: 'FECHA IMPUTACIÓN', key: 'fecha_imputacion', width: 16 },
            { header: 'FECHA DE COMPR', key: 'fecha_compra', width: 14 },
            { header: 'TIPO DE COMPROBANTE', key: 'tipo_comprobante', width: 22 },
            { header: 'N° DE COMP', key: 'numero_comprobante', width: 18 },
            { header: 'NOMBRE Y APELLIDO- RS', key: 'proveedor_nombre', width: 28 },
            { header: 'CUIT-CUIL', key: 'proveedor_cuit', width: 16 },
            { header: 'NETO', key: 'neto', width: 14 },
            { header: 'IVA', key: 'iva', width: 14 },
            { header: 'PER IVA', key: 'per_iva', width: 14 },
            { header: 'PER IIBB TUC', key: 'per_iibb_tuc', width: 16 },
            { header: 'PER TEM', key: 'per_tem', width: 14 },
            { header: 'TOTAL', key: 'total', width: 14 },
            { header: 'DEPOSITO DESTINO', key: 'deposito_destino', width: 22 },
            { header: 'REFERENCIA DE COMP', key: 'referencia_compra', width: 24 },
            { header: 'CLASIFICACION', key: 'clasificacion', width: 18 },
            { header: 'MES', key: 'mes', width: 6 },
            { header: 'AÑO', key: 'anio', width: 6 },
            { header: 'FACTURADO A', key: 'facturado_a', width: 18 },
            { header: 'GASTO REALIZADO POR', key: 'gasto_realizado_por', width: 24 }
        ];
        wsCompras.addRows(compras.map(c => ({
            ...c,
            neto: fix2(c.neto),
            iva: fix2(c.iva),
            per_iva: fix2(c.per_iva),
            per_iibb_tuc: fix2(c.per_iibb_tuc),
            per_tem: fix2(c.per_tem),
            total: fix2(c.total)
        })));

        // ----- Hoja Ventas -----
        wsVentas.columns = [
            { header: 'FECHA IMPUTACION', key: 'fecha', width: 16 },          // Recibo.fecha
            { header: 'N° DE COMP', key: 'numero_recibo', width: 14 },        // Recibo.numero_recibo
            { header: 'NOMBRE Y APELLIDO', key: 'cliente_nombre', width: 28 },// Recibo.cliente_nombre
            { header: 'CUIT-CUIL/ DNI', key: 'doc_cliente', width: 18 },      // (buscado en Cliente si existe)
            { header: 'NETO', key: 'neto', width: 14 },                       // = principal_pagado
            { header: 'IVA', key: 'iva', width: 10 },                          // usualmente 0 en financiera
            { header: 'RET GAN', key: 'ret_gan', width: 10 },
            { header: 'RETIVA', key: 'ret_iva', width: 10 },
            { header: 'RET IIBB TUC', key: 'ret_iibb_tuc', width: 14 },
            { header: 'capital', key: 'capital', width: 14 },                 // = principal_pagado
            { header: 'interes', key: 'interes', width: 14 },                 // = interes_ciclo_cobrado + mora_cobrada
            { header: 'cuotas', key: 'cuotas', width: 10 },                   // 1 por recibo
            { header: 'TOTAL', key: 'total', width: 14 },                     // = monto_pagado
            { header: 'FORMA DE PAGO', key: 'medio_pago', width: 18 },        // Recibo.medio_pago
            { header: 'FECHA FIN DE FINANCIACION', key: 'fecha_fin', width: 20 },
            { header: 'BONIFICACION (FALSO / VERD)', key: 'bonificacion', width: 24 },
            { header: 'VENDEDOR', key: 'vendedor', width: 20 },               // Recibo.nombre_cobrador
            { header: 'MES', key: 'mes', width: 6 },
            { header: 'AÑO', key: 'anio', width: 6 }
        ];

        const ventasRows = [];
        for (const r of recibos) {
            // Doc cliente (si existe campo dni/cuil en tu modelo)
            const cli = clientesMap[r.cliente_id] || {};
            const doc = cli.dni || cli.cuil || cli.cuit || '';

            // Obtener crédito desde la cuota
            const q = cuotaById[r.cuota_id];
            const cr = q ? creditoById[q.credito_id] : null;

            // Fecha fin financiación desde cuotas del crédito
            const fecha_fin = cr ? (fechaFinPorCredito[cr.id] || null) : null;

            const capital = fix2(r.principal_pagado); // Recibo.principal_pagado
            const interes = fix2(safeNum(r.interes_ciclo_cobrado) + safeNum(r.mora_cobrada)); // intereses + mora
            const total = fix2(r.monto_pagado); // Recibo.monto_pagado
            const neto = capital;               // criterio contable sugerido

            const f = new Date(r.fecha);
            const mesR = f.getMonth() + 1;
            const anioR = f.getFullYear();

            ventasRows.push({
                fecha: r.fecha,
                numero_recibo: r.numero_recibo,
                cliente_nombre: r.cliente_nombre,
                doc_cliente: doc,
                neto,
                iva: 0,
                ret_gan: 0,
                ret_iva: 0,
                ret_iibb_tuc: 0,
                capital,
                interes,
                cuotas: 1,
                total,
                medio_pago: r.medio_pago,
                fecha_fin,
                bonificacion: safeNum(r.descuento_aplicado) > 0 ? 'VERDADERO' : 'FALSO',
                vendedor: r.nombre_cobrador,
                mes: mesR,
                anio: anioR
            });
        }
        wsVentas.addRows(ventasRows);

        // ====== Output
        const wbName = `export_ventas_gastos_${new Date().toISOString().slice(0, 10)}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${wbName}"`);
        const buffer = await wb.xlsx.writeBuffer();
        res.status(200).send(Buffer.from(buffer));
    } catch (err) {
        console.error('[exportVentasYCompras]', err);
        res.status(500).json({ success: false, message: 'Error al generar exportación' });
    }
};
