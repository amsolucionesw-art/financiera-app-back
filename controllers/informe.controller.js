// backend/src/controllers/informe.controller.js
import { generarInforme } from '../services/informe.service.js';
import ExcelJS from 'exceljs';

/**
 * Construye columnas “orden preferido” y agrega cualquier otra clave faltante.
 * Esto evita romper si en el futuro el service agrega campos nuevos.
 */
const buildColumns = (preferredOrder = [], sampleRow = {}) => {
    const seen = new Set();
    const cols = [];

    // Primero, los preferidos si existen en el objeto
    for (const key of preferredOrder) {
        if (Object.prototype.hasOwnProperty.call(sampleRow, key)) {
            seen.add(key);
            cols.push({ header: key.replaceAll('_', ' ').toUpperCase(), key, width: 18 });
        }
    }
    // Luego, todas las demás claves presentes en el objeto
    for (const key of Object.keys(sampleRow)) {
        if (!seen.has(key)) {
            seen.add(key);
            cols.push({ header: key.replaceAll('_', ' ').toUpperCase(), key, width: 18 });
        }
    }
    return cols;
};

/**
 * Columnas recomendadas por tipo de informe.
 * Si alguna no existe en los datos, se omite automáticamente.
 */
const preferredColumnsByType = {
    clientes: [
        'id',
        'apellido',
        'nombre',
        'dni',
        'telefono',
        'zona',
        'cobrador',
        'numeroCreditos',
        'created_at',
        'updated_at'
    ],
    creditos: [
        'id',
        'cliente',
        'zona',
        'cobrador',
        'modalidad',
        'monto',
        'monto_a_devolver',
        'cuotas',
        'tasa',
        'estado',
        'fecha_otorgamiento',
        'fecha_ultima_actualizacion'
    ],
    cuotas: [
        'id',
        'cliente',
        'zona',
        'cobrador',
        'numero_cuota',
        'importe_cuota',
        'monto_pagado_acumulado',
        'estado',
        'fecha_vencimiento',
        'formasPago'
    ]
};

/**
 * Escribe un workbook Excel en la respuesta HTTP con una sola hoja.
 */
const writeXlsx = async (res, { rows, tipo = 'clientes', title = 'Informe' }) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Financiera App';
    workbook.created = new Date();

    const sheetName = `${title}-${tipo}`.slice(0, 31); // Excel limita a 31 chars
    const ws = workbook.addWorksheet(sheetName);

    // Determinar columnas
    const sample = rows?.[0] ?? {};
    const preferred = preferredColumnsByType[tipo] || [];
    ws.columns = buildColumns(preferred, sample);

    // Estilos de cabecera simples
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    // Agregar filas
    if (rows && rows.length) {
        ws.addRows(rows);
    }

    // Auto-filtro
    ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: ws.columns.length }
    };

    // Ajustar widths mínimos
    ws.columns.forEach((c) => {
        if (!c.width || c.width < 12) c.width = 12;
    });

    // Headers y stream
    const filename = `${title}-${tipo}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Stream directo a la respuesta (Node/Express)
    await workbook.xlsx.write(res);
    res.end();
};

/**
 * GET /informes
 * Query-params admitidos (todos opcionales):
 *   tipo = clientes | creditos | cuotas
 *   zonaId
 *   cobradorId
 *   clienteId
 *   conCreditosPendientes = true|false
 *   estadoCredito = pendiente,pagado,anulado,...
 *   estadoCuota = pagada,vencida,parcial,pendiente
 *   modalidad
 *   desde = YYYY-MM-DD
 *   hasta = YYYY-MM-DD
 *   formaPagoId
 *   hoy = true (para cuotas con vencimiento hoy si está soportado por buildFilters)
 *   q   = búsqueda libre por cliente (nombre/apellido)
 *   format = json | xlsx   (default: json)
 */
export const obtenerInforme = async (req, res, next) => {
    try {
        const { tipo = 'clientes', format = 'json', title } = req.query;
        const filtros = { ...req.query };
        delete filtros.tipo;
        delete filtros.format;
        delete filtros.title;

        const data = await generarInforme(tipo, filtros);

        // Excel
        if (String(format).toLowerCase() === 'xlsx') {
            return await writeXlsx(res, {
                rows: Array.isArray(data) ? data : [],
                tipo,
                title: title || 'Informe'
            });
        }

        // JSON (por defecto)
        return res.json({ success: true, data });
    } catch (err) {
        // Si el error viene de Sequelize, capturo el detalle útil
        if (err?.parent?.message) {
            console.error('Postgres ⇒', err.parent.message);
        } else {
            console.error(err);
        }
        next(err); // tu middleware de errores global lo capturará
    }
};